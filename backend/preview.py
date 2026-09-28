"""Bounded preview reads: select geometry before touching sample pages."""
import mmap
import struct
import numpy as np
import segyio
from backend.regular_geometry import SAMPLE_BYTES


def read_samples(survey, trace_ids, samples):
    """Read original amplitudes for selected traces.

    ``samples`` is either a 1-D array of sample indices shared by every trace
    (result gains a trailing axis) or an array matching ``trace_ids`` shape for
    per-point reads (result matches ``trace_ids`` shape).
    """
    ids = np.asarray(trace_ids, dtype=np.int64)
    samples = np.asarray(samples, dtype=np.int64)
    per_cell = samples.shape == ids.shape
    shape = ids.shape if per_cell else (*ids.shape, *samples.shape)
    result = np.full(shape, np.nan, dtype=np.float32)
    valid = ids >= 0
    if not valid.any():
        return result
    with open(survey.path, 'rb') as f:
        f.seek(3200)
        header = f.read(400)
        ns = struct.unpack_from('>H', header, 20)[0]
        fmt = struct.unpack_from('>H', header, 24)[0]
        ext = struct.unpack_from('>h', header, 304)[0]
        width = SAMPLE_BYTES.get(fmt)
        offset = 3600 + max(ext, 0) * 3200
        stride = 240 + ns * width if width else 0
        direct = ext >= 0 and ns == len(survey.times) and width and survey.path.stat().st_size == offset + survey.count * stride
        if direct:
            # Mapping reserves address space, not the complete seismic volume in RAM.
            with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mapped:
                raw = np.ndarray((survey.count, ns), dtype=f'V{width}', buffer=mapped,
                                 offset=offset + 240, strides=(stride, width))
                if per_cell:
                    picked = raw[ids[valid], samples[valid]].copy()
                else:
                    picked = raw[ids[valid, None], samples[None, :]].copy()
                del raw
            if fmt == 1:
                values = segyio.tools.native(picked.view(np.float32))
            else:
                dtype = {2:'>i4', 3:'>i2', 5:'>f4', 6:'>f8', 8:'i1',
                         9:'>i8', 10:'>u4', 11:'>u2', 12:'>u8', 16:'u1'}[fmt]
                values = picked.view(dtype).astype(np.float32)
            result[valid] = values
        else:
            # Nonstandard layouts remain supported through segyio; only selected traces.
            with segyio.open(str(survey.path), ignore_geometry=True) as sg:
                if per_cell:
                    result[valid] = [sg.trace[int(i)][int(s)] for i, s in zip(ids[valid], samples[valid])]
                else:
                    result[valid] = np.asarray([sg.trace[int(i)][samples] for i in ids[valid]])
    return result


def preview_ids(survey, ils, xls):
    if survey.regular is not None:
        return survey.regular.trace_id(np.asarray(ils)[:, None], np.asarray(xls)[None, :])
    if survey.trace_lookup is not None:
        return survey.trace_lookup[np.ix_(np.searchsorted(survey.inlines, ils), np.searchsorted(survey.crosslines, xls))]
    result = np.full((len(ils), len(xls)), -1, dtype=np.int64)
    for row, il in enumerate(ils):
        ids = survey.maps['inline'].get(int(il), [])
        coords = survey.xls[ids]
        positions = np.searchsorted(xls, coords)
        valid = positions < len(xls)
        valid &= np.asarray(xls)[np.minimum(positions, len(xls)-1)] == coords
        result[row, positions[valid]] = np.asarray(ids)[valid]
    return result
