"""Traditional trace paths and coordinate-aligned display rasters.

The paths use the original section samples and world coordinates. Both the
viewer and publication renderer call this module with the same display state;
large sources read selected original traces and never use display rasters.
"""

import math

import numpy as np

from backend import resample
from backend.slice_source import read_window


TRACE_PIXELS = 12.0
DEFAULT_VIEWPORT_WIDTH = 1000.0
DEFAULT_VIEWPORT_HEIGHT = 600.0
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


def coordinate_cell_edges(coordinates):
    """Full cell boundaries for a native, possibly irregular coordinate axis."""
    coordinates = np.asarray(coordinates, dtype=float)
    left, right = coordinate_edges(coordinates)
    return np.concatenate(([left], (coordinates[:-1] + coordinates[1:]) / 2, [right]))


def reconstruction_extent(x, time, x_range=None, time_range=None):
    """Exact visible ranges clipped to the physical source cells."""
    bounds = [*coordinate_edges(x), *coordinate_edges(time)]
    for offset, span in ((0, x_range), (2, time_range)):
        if span is not None:
            low, high = max(bounds[offset], span[0]), min(bounds[offset + 1], span[1])
            if low < high:
                bounds[offset:offset + 2] = [float(low), float(high)]
    return tuple(bounds)


def _interpolated_trace(values, time, sample_times):
    """Sinc8 within original finite runs, retaining knots and gap boundaries."""
    sampled = np.full(len(sample_times), np.nan, dtype=float)
    finite = np.isfinite(values)
    starts = np.flatnonzero(finite & np.concatenate(([True], ~finite[:-1])))
    stops = np.flatnonzero(finite & np.concatenate((~finite[1:], [True]))) + 1
    for start, stop in zip(starts, stops):
        inside = (sample_times >= time[start]) & (sample_times <= time[stop - 1])
        if not inside.any():
            continue
        indices = np.interp(sample_times[inside], time[start:stop], np.arange(stop - start, dtype=float))
        # The whole finite source run supplies the eight taps, even when only
        # a small time window is visible. Panning cannot invent a local edge.
        sampled[inside] = resample.sinc8(values[start:stop], indices)
    return sampled


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
    viewport = float(state.trace_viewport_width or DEFAULT_VIEWPORT_WIDTH)
    viewport_height = float(state.trace_viewport_height or DEFAULT_VIEWPORT_HEIGHT)
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
        low_t, high_t = float(time[0]), float(time[-1])
    sample_times = time[t0:t1]
    if state.seismic.wiggle_interpolation and high_t > low_t:
        # One vertex per CSS pixel plus every native knot. The CSS density is
        # also used in publication output, so exported paths match the viewer.
        # Dense points cover only visible time, never the native slack: a
        # sub-sample zoom must not allocate millions of points outside view.
        count = max(2, min(8000, math.ceil(viewport_height) + 1))
        dense = np.linspace(low_t, high_t, count)
        sample_times = np.unique(np.concatenate((sample_times, dense)))
    normalizer = max(abs(float(lo)), abs(float(hi))) or 1.0
    # Clip around the physical zero, even when a manual colour range is wholly
    # positive/negative. Zero remains the trace baseline and polarity survives.
    low, high = min(float(lo), 0.0), max(float(hi), 0.0)
    wiggle, area = {"x": [], "time": []}, {"x": [], "time": []}
    for displayed in selected:
        index = global_indices[displayed]
        baseline = float(x[index])
        scale = float(excursion[displayed]) / normalizer
        rows = slice(None) if state.seismic.wiggle_interpolation else slice(t0, t1)
        original = read_window(amplitudes, rows, slice(index, index + 1))[:, 0]
        values = (_interpolated_trace(original, time, sample_times)
                  if state.seismic.wiggle_interpolation else original)
        for nodes in _runs(values, sample_times, low, high):
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
        "viewport_height": viewport_height,
    }
