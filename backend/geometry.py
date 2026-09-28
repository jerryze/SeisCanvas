"""Persistent geometry only; never reads trace amplitudes."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
from zipfile import BadZipFile
import numpy as np

CACHE_DIR = Path(__file__).resolve().parents[1] / '.cache' / 'geometry'
VERSION = 1


def cache_key(path, ilbyte, xlbyte, mode="auto"):
    stat = path.stat()
    identity = [VERSION, str(path.resolve()), stat.st_size, stat.st_mtime_ns, ilbyte, xlbyte, mode]
    return hashlib.sha256(json.dumps(identity).encode()).hexdigest()


def load_geometry(key):
    try:
        with np.load(CACHE_DIR / f'{key}.npz', allow_pickle=False) as saved:
            return {name: saved[name] for name in saved.files}
    except (OSError, ValueError, EOFError, BadZipFile):
        return None


def save_geometry(key, arrays):
    temporary = None
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=CACHE_DIR, suffix='.npz', delete=False) as f:
            temporary = Path(f.name)
            np.savez(f, **arrays)
        os.replace(temporary, CACHE_DIR / f'{key}.npz')
        return True
    except OSError:
        return False  # A read-only/full cache directory must not block opening.
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def build_geometry(file, ilbyte, xlbyte, report):
    count = file.tracecount
    ids_dtype = np.int32 if count < 2**31 else np.int64
    ils = np.empty(count, dtype=np.int32)
    xls = np.empty(count, dtype=np.int32)
    # Each Field reads one 240-byte trace header; both values use its same buffer.
    for trace_id, header in enumerate(file.header):
        ils[trace_id] = header[ilbyte]
        xls[trace_id] = header[xlbyte]
        if (trace_id + 1) % 20000 == 0 or trace_id + 1 == count:
            report(5 + 70 * (trace_id + 1) / max(1, count), f'扫描道头 · {trace_id + 1:,} / {count:,} 道')
    arrays = dict(ils=ils, xls=xls, inlines=np.unique(ils), crosslines=np.unique(xls))
    for mode, values in [('inline', ils), ('crossline', xls)]:
        report(80 if mode == 'inline' else 88, f'建立 {mode.title()} 索引')
        order = np.argsort(values, kind='stable').astype(ids_dtype)
        _, starts = np.unique(values[order], return_index=True)
        arrays[f'{mode}_order'] = order
        arrays[f'{mode}_starts'] = starts.astype(ids_dtype)
    rows, cols = len(arrays['inlines']), len(arrays['crosslines'])
    # Dense lookup is bounded; sparse geometries retain compact sorted indices.
    if rows * cols <= min(32_000_000, max(count * 2, 1024)):
        lookup = np.full((rows, cols), -1, dtype=ids_dtype)
        lookup[np.searchsorted(arrays['inlines'], ils), np.searchsorted(arrays['crosslines'], xls)] = np.arange(count, dtype=ids_dtype)
        arrays['lookup'] = lookup
    return arrays


def build_regular_geometry(file, ilbyte, xlbyte, report):
    """Infer a rectangular, uniformly spaced, line-major survey from <= 12 headers."""
    count = file.tracecount
    seen = {}
    def read(i):
        if i not in seen:
            h = file.header[int(i)]
            seen[i] = (int(h[ilbyte]), int(h[xlbyte]))
        return seen[i]
    def unsupported():
        raise ValueError('无法按规则矩形排序推导几何，请切换 Geometry Mode 为 Auto。')
    report(10, '探测规则网格排序与边界')
    if count < 1:
        unsupported()
    first, last = read(0), read(count - 1)
    if count == 1:
        outer, inner, inner_count, outer_count, inner_step, outer_step = 0, 1, 1, 1, 1, 1
    else:
        second = read(1)
        changed = [i for i in range(2) if second[i] != first[i]]
        if len(changed) != 1:
            unsupported()
        inner = changed[0]; outer = 1 - inner
        inner_step = second[inner] - first[inner]
        span = last[inner] - first[inner]
        if span % inner_step:
            unsupported()
        inner_count = span // inner_step + 1
        if inner_count < 2 or count % inner_count:
            unsupported()
        outer_count = count // inner_count
        outer_step = (read(inner_count)[outer] - first[outer]) if outer_count > 1 else 1
        if not outer_step:
            unsupported()
    def expected(i):
        p = list(first)
        p[outer] += (i // inner_count) * outer_step
        p[inner] += (i % inner_count) * inner_step
        return tuple(p)
    probes = {0, count - 1, inner_count - 1, count // 2, count // 3, 2 * count // 3}
    if outer_count > 1:
        probes.update([inner_count, inner_count + 1, count - inner_count])
    if any(read(i) != expected(i) for i in probes if i < count):
        unsupported()
    report(65, '根据规则网格推导索引')
    inner_axis = first[inner] + np.arange(inner_count, dtype=np.int64) * inner_step
    outer_axis = first[outer] + np.arange(outer_count, dtype=np.int64) * outer_step
    ids_dtype = np.int32 if count < 2**31 else np.int64
    lookup = np.arange(count, dtype=ids_dtype).reshape(outer_count, inner_count)
    if outer == 1:
        lookup = lookup.T
    il_axis, xl_axis = (outer_axis, inner_axis) if outer == 0 else (inner_axis, outer_axis)
    if len(il_axis) > 1 and il_axis[1] < il_axis[0]:
        il_axis = il_axis[::-1]; lookup = lookup[::-1, :]
    if len(xl_axis) > 1 and xl_axis[1] < xl_axis[0]:
        xl_axis = xl_axis[::-1]; lookup = lookup[:, ::-1]
    lookup = np.ascontiguousarray(lookup)
    ils = np.empty(count, dtype=np.int32); xls = np.empty(count, dtype=np.int32)
    ils[lookup] = il_axis[:, None]; xls[lookup] = xl_axis[None, :]
    return dict(ils=ils, xls=xls, inlines=il_axis.astype(np.int32), crosslines=xl_axis.astype(np.int32),
                lookup=lookup, inline_order=lookup.ravel(), crossline_order=lookup.T.ravel(),
                inline_starts=np.arange(len(il_axis), dtype=ids_dtype)*len(xl_axis),
                crossline_starts=np.arange(len(xl_axis), dtype=ids_dtype)*len(il_axis))
