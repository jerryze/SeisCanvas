"""Traditional trace paths and coordinate-aligned display rasters.

The paths use the original section samples and world coordinates. Both the
viewer and publication renderer call this module with the same display state;
the section is never read again and display rasters never become trace data.
"""

import math

import numpy as np

from backend import resample


TRACE_PIXELS = 12.0
DEFAULT_VIEWPORT_WIDTH = 1000.0
WIGGLE_WIDTH = 0.6  # points; frontend uses 4/3 CSS pixels per point


def overlays_enabled(seismic):
    return seismic.wiggle or seismic.variable_area


def coordinate_edges(coordinates):
    """Outer cell edges from the actual local sample spacing."""
    coordinates = np.asarray(coordinates, dtype=float)
    if len(coordinates) == 1:
        return float(coordinates[0]) - 0.5, float(coordinates[0]) + 0.5
    return (
        float(coordinates[0] - (coordinates[1] - coordinates[0]) / 2),
        float(coordinates[-1] + (coordinates[-1] - coordinates[-2]) / 2),
    )


def _regular(coordinates):
    return len(coordinates) < 3 or np.allclose(
        np.diff(coordinates), coordinates[1] - coordinates[0], rtol=1e-7, atol=1e-9
    )


def _sample_axis(values, indices, axis, method):
    """Interpolate at source indices without changing their world mapping."""
    if method == "nearest":
        return np.take(values, np.floor(indices + 0.5).astype(np.intp), axis=axis)
    base = np.floor(indices).astype(np.intp)
    weight = indices - base
    shape = [1] * values.ndim
    shape[axis] = len(indices)
    if method == "bilinear":
        right = np.minimum(base + 1, values.shape[axis] - 1)
        weight = weight.reshape(shape)
        return np.take(values, base, axis=axis) * (1 - weight) + np.take(values, right, axis=axis) * weight
    # Catmull-Rom interpolation in source-index space, mapped through the real
    # coordinates first. Its knots remain exactly at the original samples.
    result = 0.0
    for offset in (-1, 0, 1, 2):
        distance = np.abs(weight - offset)
        kernel = np.where(
            distance <= 1,
            1.5 * distance**3 - 2.5 * distance**2 + 1,
            np.where(distance < 2, -0.5 * distance**3 + 2.5 * distance**2 - 4 * distance + 2, 0),
        ).reshape(shape)
        source = np.clip(base + offset, 0, values.shape[axis] - 1)
        result = result + np.take(values, source, axis=axis) * kernel
    return result


def aligned_raster(x, time, values, width, height, method):
    """Raster and uniformly spaced world sample centres with correct cell edges.

    Pillow's half-pixel mapping is correct for regular source coordinates when
    the image extent uses real half-sample edges. Irregular trace numbers need
    a world-to-source mapping before interpolation rather than index linspace.
    """
    x, time = np.asarray(x, dtype=float), np.asarray(time, dtype=float)
    values = np.asarray(values, dtype=np.float32)
    left, right = coordinate_edges(x)
    top, bottom = coordinate_edges(time)
    gx = left + (np.arange(width) + 0.5) * (right - left) / width
    gt = top + (np.arange(height) + 0.5) * (bottom - top) / height
    if method != "nearest" and _regular(x) and _regular(time):
        raster = resample.resample(values, width, height, method)
    else:
        xi = np.interp(gx, x, np.arange(len(x), dtype=float))
        ti = np.interp(gt, time, np.arange(len(time), dtype=float))
        raster = _sample_axis(values, xi, 1, method)
        raster = _sample_axis(raster, ti, 0, method).astype(np.float32)
        finite = values[np.isfinite(values)]
        if len(finite):
            np.clip(raster, finite.min(), finite.max(), out=raster)
    return raster, gx, gt, (left, right, top, bottom)


def _runs(values, time, low, high):
    """Finite trace runs, including true zero/clip crossings between samples."""
    run = []
    previous = None
    levels = sorted(set((low, 0.0, high)))
    for value, at in zip(values, time):
        if not np.isfinite(value) or not np.isfinite(at):
            if run:
                yield run
            run, previous = [], None
            continue
        value, at = float(value), float(at)
        if previous is not None:
            before, before_time = previous
            if value != before:
                crossings = [
                    ((level - before) / (value - before), level)
                    for level in levels if min(before, value) < level < max(before, value)
                ]
                for fraction, level in sorted(crossings):
                    run.append((before_time + fraction * (at - before_time), level))
        run.append((at, min(high, max(low, value))))
        previous = value, at
    if run:
        yield run


def _append_path(path, points):
    if path["x"]:
        path["x"].append(None)
        path["time"].append(None)
    for x, time in points:
        path["x"].append(float(x))
        path["time"].append(float(time))


def _positive_lobes(nodes, baseline, scale):
    lobe = []
    start = None
    last_zero = None
    for at, value in nodes:
        if value > 0:
            if not lobe:
                start = at if last_zero is None else last_zero
                lobe = [(baseline, start)]
            lobe.append((baseline + value * scale, at))
        else:
            if lobe:
                # A zero-crossing node precedes every negative sample, so this
                # boundary follows the original amplitude's interpolated zero.
                lobe.extend([(baseline, at), (baseline, start)])
                yield lobe
                lobe = []
            last_zero = at if value == 0 else None
    if lobe:
        lobe.extend([(baseline, nodes[-1][0]), (baseline, start)])
        yield lobe


def build_trace_overlay(x, time, amplitudes, state, lo, hi):
    """Null-separated lines/polygons, using polarity-transformed amplitudes."""
    if not overlays_enabled(state.seismic):
        return None
    x, time = np.asarray(x, dtype=float), np.asarray(time, dtype=float)
    amplitudes = np.asarray(amplitudes)
    viewport = float(state.trace_viewport_width or DEFAULT_VIEWPORT_WIDTH)
    differences = np.diff(x)
    differences = differences[np.isfinite(differences) & (differences > 0)]
    native_spacing = float(np.median(differences)) if len(differences) else 1.0
    low_x, high_x = state.x_range or coordinate_edges(x)
    step = max(1, math.ceil(TRACE_PIXELS * (high_x - low_x) / native_spacing / viewport))
    global_indices = np.arange(0, len(x), step, dtype=np.intp)
    baselines = x[global_indices]
    # Half the displayed spacing, including decimation. This keeps amplitudes
    # legible when zoomed out; the phase is anchored to original trace index 0.
    spacing = np.full(len(baselines), native_spacing * step)
    if len(baselines) > 1:
        distances = np.diff(baselines)
        spacing[0], spacing[-1] = distances[0], distances[-1]
        if len(baselines) > 2:
            spacing[1:-1] = (distances[:-1] + distances[1:]) / 2
    excursion = spacing * state.seismic.wiggle_gain / 2
    selected = np.flatnonzero((baselines + excursion >= low_x) & (baselines - excursion <= high_x))
    if state.time_range:
        low_t, high_t = state.time_range
        t0 = max(0, int(np.searchsorted(time, low_t, side="left")) - 1)
        t1 = min(len(time), int(np.searchsorted(time, high_t, side="right")) + 1)
    else:
        t0, t1 = 0, len(time)
    normalizer = max(abs(float(lo)), abs(float(hi))) or 1.0
    # Clip around the physical zero, even when a manual colour range is wholly
    # positive/negative. Zero remains the trace baseline and polarity survives.
    low, high = min(float(lo), 0.0), max(float(hi), 0.0)
    wiggle, area = {"x": [], "time": []}, {"x": [], "time": []}
    for displayed in selected:
        index = global_indices[displayed]
        baseline = float(x[index])
        scale = float(excursion[displayed]) / normalizer
        for nodes in _runs(amplitudes[t0:t1, index], time[t0:t1], low, high):
            if state.seismic.wiggle:
                _append_path(wiggle, ((baseline + value * scale, at) for at, value in nodes))
            if state.seismic.variable_area and scale > 0:
                for polygon in _positive_lobes(nodes, baseline, scale):
                    _append_path(area, polygon)
    return {
        "wiggle": wiggle,
        "variable_area": area,
        "trace_step": step,
        "trace_count": len(selected),
        "viewport_width": viewport,
    }
