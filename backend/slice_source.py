"""Windowed original slice samples without materializing a complete slice.

Geometry selection is shared with full section/time-slice readers; this layer
has no rendering dependencies. Only the requested output and bounded read
buffers are allocated, and statistics can walk the same source repeatedly.
"""
from operator import index

import numpy as np
import segyio

from backend import preview


READ_BLOCK_ELEMENTS = 262_144
# Small sections retain the existing fast native cache. Large sections remain
# replayable sources, including while zoomed into only a small viewport.
NATIVE_CACHE_ELEMENTS = 1_000_000


def section_input(survey, kind, position):
    if hasattr(survey, "section_indices"):
        source = SliceSource(survey, kind, position)
        if source.shape[0] * source.shape[1] > NATIVE_CACHE_ELEMENTS:
            return source.x, source.time, source
    return survey.section(kind, position)


def read_window(values, rows, columns):
    return values.read(rows, columns) if hasattr(values, "read") else values[rows, columns]


class PolaritySource:
    """Apply sign only to requested samples; never copy a complete section."""

    def __init__(self, source):
        self.source, self.shape, self.dtype = source, source.shape, source.dtype

    def read(self, rows, columns):
        return -self.source.read(rows, columns)


def polarity(values, reverse):
    if not reverse:
        return values
    return PolaritySource(values) if hasattr(values, "read") else -values


def source_limits(sources, seismic, *, survey=None, cache_id=None, omit_empty_sources=False):
    """Cache scalar ranges for unchanged large native slices across zoom/pan."""
    from backend.amplitude_stats import amplitude_limits
    from backend.segy import LOCK

    cache = None
    if sources and all(isinstance(source, SliceSource) and source.survey is sources[0].survey
                       for source in sources):
        survey = sources[0].survey
        cache_id = tuple(source.cache_id for source in sources)
    if survey is not None and cache_id is not None:
        cache = survey.render_cache
        key = ("native-amplitude", cache_id, omit_empty_sources,
               seismic.clip_mode, seismic.clip_percentile, seismic.symmetric,
               seismic.reverse_polarity, seismic.vmin, seismic.vmax)
        with LOCK:
            cached = cache.get(key)
            if cached is not None:
                cache.move_to_end(key)
                return cached
    limits = amplitude_limits(sources, seismic, omit_empty_sources=omit_empty_sources)
    if cache is not None:
        with LOCK:
            cache[key] = limits
    return limits


def _axis_indices(selection, size):
    if isinstance(selection, slice):
        start, stop, step = selection.indices(size)
        return np.arange(start, stop, step, dtype=np.int64)
    values = np.asarray(selection)
    if values.ndim != 1 or (values.size and values.dtype.kind not in "iu"):
        raise ValueError("Slice indices must be one-dimensional integer arrays.")
    values = values.astype(np.int64, copy=False)
    if values.size and (np.any(values < -size) or np.any(values >= size)):
        raise IndexError("Slice index is outside its native axis.")
    return np.where(values < 0, values + size, values)


def _tiles(shape, max_elements):
    limit = index(max_elements)
    if limit < 1:
        raise ValueError("Block element limit must be positive.")
    rows, columns = shape
    if not rows or not columns:
        return
    width = min(columns, limit)
    height = max(1, limit // width)
    for row in range(0, rows, height):
        for column in range(0, columns, width):
            yield (slice(row, min(row + height, rows)),
                   slice(column, min(column + width, columns)))


class SliceSource:
    """A native inline, crossline or snapped time slice with bounded reads."""

    dtype = np.dtype(np.float32)

    def __init__(self, survey, kind, position):
        if kind not in ("inline", "crossline", "time"):
            raise ValueError("Unknown slice kind.")
        self.survey = survey
        self.kind = kind
        self.time_sinc = kind != "time"
        if kind == "time":
            if not survey.times[0] <= position <= survey.times[-1]:
                raise ValueError("Time slice is outside the survey time range.")
            self._sample = int(np.argmin(np.abs(survey.times - position)))
            self.position = float(survey.times[self._sample])
            self.x, self.time = survey.crosslines, survey.inlines
            if survey.regular is not None:
                # timeslice_grid preserves depth_slice's original scalar type;
                # auto geometry instead assigns into a float32 NaN grid.
                with segyio.open(str(survey.path), ignore_geometry=True) as file:
                    self.dtype = np.dtype(file.dtype)
        else:
            if not np.isfinite(position) or position != int(position):
                raise ValueError("Section does not exist in this survey.")
            self.position = int(position)
            self.x, self._trace_ids = survey.section_indices(kind, self.position)
            self.time = survey.times
        self.shape = (len(self.time), len(self.x))
        self.cache_id = (kind, self.position)

    def read(self, rows, columns):
        """Return exact native values for a Cartesian selection, in caller order.

        Large selections necessarily allocate their requested output; selected
        amplitude buffers are tiled within READ_BLOCK_ELEMENTS. Geometry work
        scales with axis/inline length, and segyio's fallback can read a whole
        trace. Repeated and unsorted selections retain their caller ordering.
        """
        rows = _axis_indices(rows, self.shape[0])
        columns = _axis_indices(columns, self.shape[1])
        result = np.empty((len(rows), len(columns)), dtype=self.dtype)
        for row_slice, column_slice in _tiles(result.shape, READ_BLOCK_ELEMENTS):
            selected_rows, selected_columns = rows[row_slice], columns[column_slice]
            if self.kind == "time":
                # Sparse preview_ids uses searchsorted and therefore needs a
                # sorted crossline axis. Restore duplicates/order afterwards.
                ordered_columns, inverse = np.unique(selected_columns, return_inverse=True)
                ids = preview.preview_ids(self.survey, self.time[selected_rows], self.x[ordered_columns])
                values = preview.read_samples(self.survey, ids, [self._sample], dtype=self.dtype)[..., 0]
                result[row_slice, column_slice] = values[:, inverse]
            else:
                values = preview.read_samples(self.survey, self._trace_ids[selected_columns], selected_rows).T
                # Match Survey.section, including the float32 Inf replacement.
                np.nan_to_num(values, copy=False)
                result[row_slice, column_slice] = values
        return result

    def iter_blocks(self, max_elements=READ_BLOCK_ELEMENTS):
        """Iterate every native value in repeatable, bounded rectangular blocks."""
        if self.time_sinc:
            # SEG-Y is trace-major: scan adjacent complete traces where they
            # fit. Thin time strips across thousands of traces would fault in
            # many mostly unused file pages on every percentile pass.
            for columns, rows in _tiles(self.shape[::-1], max_elements):
                yield self.read(rows, columns)
        else:
            for rows, columns in _tiles(self.shape, max_elements):
                yield self.read(rows, columns)

    def iter_amplitude_blocks(self, max_elements=READ_BLOCK_ELEMENTS):
        """Replay actual grid amplitudes without scanning sparse empty cells.

        Missing geometry is NaN in a full time plane and cannot contribute to
        amplitude statistics. Real NaN/Inf samples remain unchanged for the
        statistics layer to handle. Sparse duplicate nodes keep the final
        trace in file order, matching timeslice/preview_ids assignment.
        """
        limit = index(max_elements)
        if limit < 1:
            raise ValueError("Block element limit must be positive.")
        if self.time_sinc:
            yield from self.iter_blocks(max_elements)
            return
        limit = min(limit, READ_BLOCK_ELEMENTS)

        def samples(ids):
            return preview.read_samples(self.survey, ids, [self._sample], dtype=self.dtype)[..., 0]

        if self.survey.regular is not None:
            # Every trace is one grid node; file order maximizes locality.
            for start in range(0, self.survey.count, limit):
                yield samples(np.arange(start, min(start + limit, self.survey.count), dtype=np.int64))
        elif self.survey.trace_lookup is not None:
            lookup = self.survey.trace_lookup
            for start in range(0, lookup.size, limit):
                # flat slicing copies at most one block even for strided input.
                ids = lookup.flat[start:start + limit]
                ids = ids[ids >= 0]
                if ids.size:
                    yield samples(ids)
        else:
            buffer_size = min(limit, self.survey.count)
            if not buffer_size:
                return
            pending = np.empty(buffer_size, dtype=np.int64)
            filled = 0
            for inline in self.survey.inlines:
                ids = self.survey.maps["inline"].get(int(inline), ())
                if not len(ids):
                    continue
                # Deduplicate one inline at a time, never the full trace index
                # or the possibly enormous Cartesian geometry grid.
                ids = np.asarray(ids)
                _, reverse_positions = np.unique(self.survey.xls[ids[::-1]], return_index=True)
                positions = len(ids) - 1 - reverse_positions
                start = 0
                while start < len(positions):
                    take = min(buffer_size - filled, len(positions) - start)
                    pending[filled:filled + take] = ids[positions[start:start + take]]
                    filled += take
                    start += take
                    if filled == buffer_size:
                        yield samples(pending)
                        filled = 0
            if filled:
                yield samples(pending[:filled])
