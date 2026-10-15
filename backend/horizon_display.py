"""Read-only 1D horizon display geometry shared by the viewer and figure export."""
from collections import OrderedDict
import hashlib
from weakref import WeakKeyDictionary

import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.signal import savgol_filter

SG_WINDOWS = (5, 7, 11, 15)
SG_ORDER = 2
_CACHE = WeakKeyDictionary()
_CACHE_SIZE = 32  # Per horizon; discarded automatically when it is removed/reloaded.


def coordinate_step(coordinates):
    """Conservative base spacing; larger/irregular steps are segment boundaries."""
    x = np.asarray(coordinates, dtype=float)
    x = np.unique(x[np.isfinite(x)])
    dx = np.diff(x)
    return float(dx.min()) if len(dx) else None


def sg_points(points, window=7, step=None):
    """Sort known-coordinate blocks and smooth only contiguous uniform runs.

    Unknown x values remain barriers. Known x with invalid TWT sorts into its
    proper position and breaks a run. Duplicate x values are kept unsmoothed.
    No resampling or coordinate changes: extra NaN rows only break SVG paths.
    """
    if window not in SG_WINDOWS:
        raise ValueError("SG window must be 5, 7, 11 or 15 traces.")
    raw = np.asarray(points, dtype=float).reshape(-1, 2)
    if not len(raw):
        return raw.copy()
    # Sort independently on each side of an explicit unknown-coordinate gap.
    blocks, start = [], 0
    for i in np.flatnonzero(~np.isfinite(raw[:, 0])):
        blocks.extend((raw[start:i][np.argsort(raw[start:i, 0], kind="stable")], raw[i:i + 1]))
        start = i + 1
    blocks.append(raw[start:][np.argsort(raw[start:, 0], kind="stable")])
    ordered = np.concatenate(blocks).copy()
    if step is None:
        step = coordinate_step(ordered[:, 0])
    valid = np.isfinite(ordered).all(axis=1)
    dx = np.diff(ordered[:, 0])
    regular = np.isclose(dx, step, rtol=1e-6, atol=1e-8) if step else np.zeros(len(dx), dtype=bool)
    # Conflicting picks at one x have no unique time sequence. Isolate both.
    duplicates = np.zeros(len(ordered), dtype=bool)
    duplicate_edges = np.flatnonzero(dx == 0)
    duplicates[duplicate_edges] = duplicates[duplicate_edges + 1] = True
    linked = valid[:-1] & valid[1:] & regular & ~duplicates[:-1] & ~duplicates[1:]
    boundaries = np.r_[0, np.flatnonzero(~linked) + 1, len(ordered)]
    for a, b in zip(boundaries[:-1], boundaries[1:]):
        if not valid[a:b].all():
            continue
        size = min(window, b - a)
        size -= (size + 1) % 2  # Largest odd window that fits this segment.
        if size <= SG_ORDER:
            continue
        values = savgol_filter(ordered[a:b, 1], size, SG_ORDER, mode="interp")
        if np.isfinite(values).all():
            ordered[a:b, 1] = values
    display = []
    for i, point in enumerate(ordered):
        if i and valid[i - 1] and valid[i] and not linked[i - 1]:
            display.append([np.nan, np.nan])
        display.append(point)
    return np.asarray(display, dtype=float).reshape(-1, 2)


def sg_section(horizon, mode, number, window, coordinates, points=None):
    """Cache complete sections independently of zoom, time range and styling.

    A digest of the raw section catches both in-place edits and replacements.
    The weak per-horizon owner isolates IDs and is evicted on horizon removal.
    """
    raw = np.asarray(horizon.section(mode, number) if points is None else points,
                     dtype=float).reshape(-1, 2)
    step = coordinate_step(coordinates)
    key = (mode, number, window, step)
    digest = hashlib.blake2b(raw.tobytes(), digest_size=16).digest()
    cache = _CACHE.setdefault(horizon, OrderedDict())
    entry = cache.get(key)
    if entry is not None and entry[0] == digest:
        cache.move_to_end(key)
        return entry[1]
    display = sg_points(raw, window, step)
    display.setflags(write=False)
    cache[key] = (digest, display)
    cache.move_to_end(key)
    while len(cache) > _CACHE_SIZE:
        cache.popitem(last=False)
    return display


def json_points(points):
    """JSON gaps, without quantizing or changing the finite coordinates."""
    return np.where(np.isfinite(points), points, None).tolist()


def pchip_display(points, x_range, width):
    """Export PCHIP through SG display knots, retaining gaps and vector strokes."""
    raw = np.asarray(points, dtype=float).reshape(-1, 2)
    if len(raw) < 2:
        return raw
    finite = np.isfinite(raw).all(axis=1)
    lo, hi = sorted(x_range)
    if hi <= lo:
        return raw
    grid = np.linspace(lo, hi, min(32000, max(1, int(width))) + 1)
    result, start = [], 0
    for stop in [*np.flatnonzero(~finite), len(raw)]:
        segment = raw[start:stop]
        if len(segment) >= 2 and (np.diff(segment[:, 0]) > 0).all():
            x = np.unique(np.r_[segment[:, 0], grid[(grid > segment[0, 0]) & (grid < segment[-1, 0])]])
            result.extend(np.column_stack((x, PchipInterpolator(segment[:, 0], segment[:, 1])(x))))
        else:
            result.extend(segment)
        if stop < len(raw):
            result.append(raw[stop])
        start = stop + 1
    return np.asarray(result, dtype=float).reshape(-1, 2)
