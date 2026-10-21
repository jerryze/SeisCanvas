"""Horizon maps: geometry/color-scalar separation, contours and publication render.

The map geometry is always Inline/Crossline/Time; the color scalar is selected by
``HorizonMapState.color_by`` (horizon Time today, seismic amplitude sampled along
the horizon, difference between two horizons later).  The web preview and the
matplotlib renderer consume the same ``HorizonMapData``, so a scalar only has to
be implemented once (horizon_map_v2 requirements, phases 1-2).
"""
import io
from dataclasses import dataclass

import numpy as np
import contourpy
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap, Normalize, to_hex
from matplotlib.figure import Figure
from backend.figure_export import figure_size, save_figure
from matplotlib.cm import ScalarMappable
from backend.models import HorizonMapExport, HorizonMapState, Seismic, ViewState
from backend import resample
from backend.preview import preview_ids, read_samples, trace_ids_at
from backend.scene import horizon_grid, serial
from backend.style import font_family
from backend.section_service import section_raster
from backend.rendering import amplitude, _path_segments, _publication_raster, draw_horizon
from backend.trace_overlay import build_trace_overlay, overlays_enabled, WIGGLE_WIDTH
from matplotlib.collections import LineCollection, PolyCollection

__all__ = [
    "HorizonMapData",
    "map_scalar",
    "map_values",
    "map_data",
    "render_map",
    "map_profile",
    "sample_seismic_line",
    "sample_amplitude",
    "sample_difference",
    "difference_horizons",
    "resample_to_grid",
    "difference_statistics",
]

#: How far the A–B profile path extends beyond each end, as a fraction of the
#: A–B length (clipped to the surveyed extent).
PROFILE_EXTENSION = 0.15
#: Upper bound on interpolated traces in one profile section (payload guard).
PROFILE_MAX_TRACES = 1200

PETREL = ['#ff0000', '#ff8000', '#ffff00', '#00c040', '#00ffff', '#0000ff', '#8000c0', '#ff00ff']


@dataclass
class HorizonMapData:
    """Horizon geometry plus the active color scalar (horizon_map_v2 §22)."""

    x: np.ndarray          # crossline axis
    y: np.ndarray          # inline axis
    twt: np.ndarray        # Time grid (ms), NaN where unpicked
    scalar: np.ndarray     # active color scalar, NaN = invalid
    name: str              # "Time" / "Amplitude"
    unit: str              # "ms" / ""
    label: str             # colorbar caption, e.g. "Time (ms)"

    @property
    def valid(self):
        return np.isfinite(self.scalar)


def sample_amplitude(survey, horizon, x, y, twt):
    """Sample the seismic volume along the horizon, linear in time.

    Non-integer sample positions interpolate between the two bracketing
    samples; cells without a trace or outside the survey time range stay NaN.
    The result only depends on the horizon grid, so it is cached on the
    horizon object like ``_grid3d`` (horizons are dropped with the survey).
    """
    cached = getattr(horizon, "_amplitude3d", None)
    if cached is not None and cached[0] is x:
        return cached[2]
    # Horizon footprints may extend beyond the seismic cube, and preview_ids
    # snaps coordinates to survey axes, so look traces up only for cells that
    # sit exactly on the survey grid; everything else has no amplitude.
    on_grid = np.isin(y, survey.inlines)[:, None] & np.isin(x, survey.crosslines)[None, :]
    ids = np.full(twt.shape, -1, dtype=np.int64)
    if on_grid.any():
        rows = np.flatnonzero(on_grid.any(axis=1))
        cols = np.flatnonzero(on_grid.any(axis=0))
        ids[np.ix_(rows, cols)] = preview_ids(survey, y[rows], x[cols])
        ids[~on_grid] = -1
    position = (twt - survey.times[0]) / survey.interval
    finite = np.isfinite(position)
    lower = np.zeros(position.shape, dtype=np.int64)
    lower[finite] = np.floor(position[finite]).astype(np.int64)
    frac = np.zeros(position.shape, dtype=float)
    frac[finite] = position[finite] - lower[finite]
    last = len(survey.times) - 1
    inside = finite & (lower >= 0) & (lower + 1 <= last)
    clipped = np.clip(lower, 0, last)
    low = read_samples(survey, ids, clipped)
    high = read_samples(survey, ids, np.clip(clipped + 1, 0, last))
    amplitude = low * (1.0 - frac) + high * frac
    amplitude = np.asarray(amplitude, dtype=float)
    amplitude[~inside] = np.nan
    amplitude[~np.isfinite(amplitude)] = np.nan
    horizon._amplitude3d = (x, y, amplitude)
    return amplitude


def _fractional_index(src, query):
    """Fractional position of each query on a sorted, uniformly stepped axis."""
    if len(src) == 1:
        pos = np.where(np.isclose(query, src[0]), 0.0, np.nan)
        return np.asarray(pos, dtype=float)
    step = src[1] - src[0]
    pos = (np.asarray(query, dtype=float) - src[0]) / step
    pos[(query < src[0]) | (query > src[-1])] = np.nan
    return pos


def resample_to_grid(src_x, src_y, grid, dst_x, dst_y):
    """Bilinear resample of ``grid`` onto another regular axis pair.

    Positions outside the source extent become NaN.  Missing picks are NaN:
    their corner weight is dropped and the remaining corners renormalise, so
    one invalid neighbour never poisons a cell whose own position is valid
    (a fully unsupported cell stays NaN instead of reading as zero).
    """
    px = _fractional_index(src_x, dst_x)
    py = _fractional_index(src_y, dst_y)
    last_col = max(len(src_x) - 2, 0)
    last_row = max(len(src_y) - 2, 0)
    col0 = np.clip(np.nan_to_num(np.floor(px)).astype(np.int64), 0, last_col)
    row0 = np.clip(np.nan_to_num(np.floor(py)).astype(np.int64), 0, last_row)
    col1 = np.clip(col0 + 1, 0, len(src_x) - 1)
    row1 = np.clip(row0 + 1, 0, len(src_y) - 1)
    fx = np.nan_to_num(px - col0)
    fy = np.nan_to_num(py - row0)
    w00 = (1 - fx)[None, :] * (1 - fy)[:, None]
    w01 = fx[None, :] * (1 - fy)[:, None]
    w10 = (1 - fx)[None, :] * fy[:, None]
    w11 = fx[None, :] * fy[:, None]
    known = np.isfinite(grid)
    safe = np.where(known, grid, 0.0)
    corner = [
        (np.ix_(row0, col0), w00),
        (np.ix_(row0, col1), w01),
        (np.ix_(row1, col0), w10),
        (np.ix_(row1, col1), w11),
    ]
    resampled = sum(np.where(known[idx], safe[idx], 0.0) * weight for idx, weight in corner)
    weight = sum(np.where(known[idx], weight, 0.0) for idx, weight in corner)
    resampled = np.where(weight > 0, resampled / weight, np.nan)
    outside = np.isnan(px)[None, :] | np.isnan(py)[:, None]
    resampled[outside] = np.nan
    return resampled


def difference_horizons(state, horizons):
    """Resolve the same reference/comparison pair for data and export labels."""
    if not horizons:
        raise ValueError("Difference needs the loaded horizons.")
    reference = horizons.get(state.difference_reference or "")
    comparison = horizons.get(state.difference_comparison or "")
    if reference is None or comparison is None:
        raise ValueError("Difference needs a reference and a comparison horizon.")
    return reference, comparison


def _signed_difference(horizon, state, horizons):
    """Comparison minus reference, bilinearly resampled onto this grid.

    Geometry comes from the currently selected horizon, so grids with
    different spacing still line up.  The result only depends on the horizon
    pair, so it is cached on the geometry horizon like the other lazy grids.
    """
    reference, comparison = difference_horizons(state, horizons)
    x, y, _ = horizon_grid(horizon)
    cached = getattr(horizon, "_difference3d", None)
    if cached is not None and cached[:4] == (x, y, state.difference_reference, state.difference_comparison):
        return cached[4]
    rx, ry, rgrid = horizon_grid(reference)
    cx, cy, cgrid = horizon_grid(comparison)
    ref_on_grid = resample_to_grid(rx, ry, rgrid, x, y)
    comp_on_grid = resample_to_grid(cx, cy, cgrid, x, y)
    signed = comp_on_grid - ref_on_grid
    horizon._difference3d = (x, y, state.difference_reference, state.difference_comparison, signed)
    return signed


def sample_difference(horizon, state, horizons):
    """The difference scalar selected by ``difference_type``."""
    signed = _signed_difference(horizon, state, horizons)
    return np.abs(signed) if state.difference_type == "absolute" else signed


def difference_statistics(signed):
    """MAE / RMSE / Bias / Valid ratio over the common valid area only.

    NaN never participates: ``comp - ref`` is finite exactly where both
    horizons have a pick, so the finite cells are the common valid area.
    """
    common = np.isfinite(signed)
    count = int(common.sum())
    total = int(signed.size)
    if not count:
        return {"mae": None, "rmse": None, "bias": None, "valid_ratio": 0.0, "count": 0}
    values = signed[common].astype(float)
    return {
        "mae": float(np.mean(np.abs(values))),
        "rmse": float(np.sqrt(np.mean(values**2))),
        "bias": float(np.mean(values)),
        "valid_ratio": count / total if total else 0.0,
        "count": count,
    }


def _bilinear_points(src_x, src_y, grid, qx, qy):
    """Strict bilinear sampling of ``grid`` at (qx=crossline, qy=inline).

    Unlike :func:`resample_to_grid` (which renormalises around holes to keep
    maps filled), a profile must show gaps where data is missing
    (horizon_map_v2 §9): a sample whose bilinear stencil touches a missing
    pick is NaN and the curve breaks instead of bridging the hole.
    """
    px = _fractional_index(src_x, qx)
    py = _fractional_index(src_y, qy)
    finite = np.isfinite(px) & np.isfinite(py)
    col0 = np.clip(np.nan_to_num(np.floor(px)).astype(np.int64), 0, max(len(src_x) - 2, 0))
    row0 = np.clip(np.nan_to_num(np.floor(py)).astype(np.int64), 0, max(len(src_y) - 2, 0))
    col1 = np.clip(col0 + 1, 0, len(src_x) - 1)
    row1 = np.clip(row0 + 1, 0, len(src_y) - 1)
    fx = np.nan_to_num(px - col0)
    fy = np.nan_to_num(py - row0)
    corners = [
        (grid[row0, col0], (1 - fx) * (1 - fy)),
        (grid[row0, col1], fx * (1 - fy)),
        (grid[row1, col0], (1 - fx) * fy),
        (grid[row1, col1], fx * fy),
    ]
    total = np.zeros(len(qx))
    acc = np.zeros(len(qx))
    complete = np.ones(len(qx), dtype=bool)
    for values, weight in corners:
        known = np.isfinite(values)
        # A zero-weight corner cannot contribute, so its being missing is
        # irrelevant: this keeps exact-node samples valid next to holes.
        complete &= known | (weight == 0)
        total += weight
        acc += np.where(known, values, 0.0) * weight
    out = np.where(complete, acc / np.where(total > 0, total, 1.0), np.nan)
    out[~finite] = np.nan
    return out


def sample_seismic_line(survey, qil, qxl):
    """Interpolated seismic traces along a path of floating grid positions.

    For every (inline, crossline) position the four surrounding survey traces
    are bilinearly blended per time sample, producing a spatially continuous
    trace (horizon_map_v2 profile).  Positions outside the surveyed extent and
    traces missing at a node yield NaN; the result has shape ``(len(qil), ns)``
    with rows ordered along the path.
    """
    ns = len(survey.times)
    i0 = np.clip(np.searchsorted(survey.inlines, qil, side="right") - 1, 0, len(survey.inlines) - 2)
    i1 = i0 + 1
    j0 = np.clip(np.searchsorted(survey.crosslines, qxl, side="right") - 1, 0, len(survey.crosslines) - 2)
    j1 = j0 + 1
    node_i0, node_i1 = survey.inlines[i0], survey.inlines[i1]
    node_j0, node_j1 = survey.crosslines[j0], survey.crosslines[j1]
    span_i = node_i1 - node_i0
    span_j = node_j1 - node_j0
    fy = np.where(span_i > 0, (qil - node_i0) / np.where(span_i > 0, span_i, 1.0), 0.0)
    fx = np.where(span_j > 0, (qxl - node_j0) / np.where(span_j > 0, span_j, 1.0), 0.0)
    samples = np.arange(ns)
    v00 = read_samples(survey, trace_ids_at(survey, node_i0, node_j0), samples)
    v01 = read_samples(survey, trace_ids_at(survey, node_i0, node_j1), samples)
    v10 = read_samples(survey, trace_ids_at(survey, node_i1, node_j0), samples)
    v11 = read_samples(survey, trace_ids_at(survey, node_i1, node_j1), samples)
    w00 = ((1 - fy) * (1 - fx))[:, None]
    w01 = ((1 - fy) * fx)[:, None]
    w10 = (fy * (1 - fx))[:, None]
    w11 = (fy * fx)[:, None]
    corners = [(v00, w00), (v01, w01), (v10, w10), (v11, w11)]
    known = [np.isfinite(v) for v, _ in corners]
    total = sum(np.where(k, w, 0.0) for (_, w), k in zip(corners, known))
    acc = sum(np.where(k, v, 0.0) * np.where(k, w, 0.0) for (v, w), k in zip(corners, known))
    section = np.where(total > 0, acc / np.where(total > 0, total, 1.0), np.nan)
    inside = (
        (qil >= survey.inlines[0]) & (qil <= survey.inlines[-1])
        & (qxl >= survey.crosslines[0]) & (qxl <= survey.crosslines[-1])
    )
    section[~inside] = np.nan
    return section


def _profile_data(survey, state, horizons, a, b, target_width=None, target_height=None, interpolation=None, display_state=None):
    """Compute the A–B section as numpy arrays (web and renderer share it).

    The path runs through A and B, extends ``PROFILE_EXTENSION`` beyond both
    ends and is clipped to the surveyed extent; traces are placed at a fixed
    one-grid-unit spatial step.  Every floating position gets a bilinearly
    interpolated trace from its four surrounding survey traces, every loaded
    horizon contributes its Time along the exact same path, and A/B are
    reported as distances from the start of the section.
    """
    try:
        (ail, axl), (bil, bxl) = (float(a[0]), float(a[1])), (float(b[0]), float(b[1]))
    except (TypeError, ValueError, IndexError) as e:
        raise ValueError("Profile end points must be (inline, crossline) pairs.") from e
    if not all(np.isfinite(v) for v in (ail, axl, bil, bxl)):
        raise ValueError("Profile end points must be finite coordinates.")
    if survey is None:
        raise ValueError("The seismic profile needs a loaded SEG-Y survey.")
    if (ail, axl) == (bil, bxl):
        raise ValueError("Profile end points A and B must be two different positions.")
    d_il, d_xl = bil - ail, bxl - axl
    length = float(np.hypot(d_il, d_xl))

    # Clip the extended path to the surveyed rectangle.
    il_lo, il_hi = float(survey.inlines[0]), float(survey.inlines[-1])
    xl_lo, xl_hi = float(survey.crosslines[0]), float(survey.crosslines[-1])
    t_lo, t_hi = -PROFILE_EXTENSION, 1.0 + PROFILE_EXTENSION
    for bound_lo, bound_hi, start, delta in ((il_lo, il_hi, ail, d_il), (xl_lo, xl_hi, axl, d_xl)):
        if delta == 0:
            if not bound_lo <= start <= bound_hi:
                raise ValueError("Profile path lies outside the survey extent.")
            continue
        first, second = (bound_lo - start) / delta, (bound_hi - start) / delta
        t_lo = max(t_lo, min(first, second))
        t_hi = min(t_hi, max(first, second))
    if t_hi <= t_lo:
        raise ValueError("Profile path lies outside the survey extent.")

    # Fixed spatial step: one survey grid unit along the shorter axis spacing.
    steps = [
        float(np.median(np.diff(axis))) for axis in (survey.inlines, survey.crosslines) if len(axis) > 1
    ]
    step = min(steps) if steps else 1.0
    step = step if step > 0 else 1.0
    count = int(min(PROFILE_MAX_TRACES, max(2, round((t_hi - t_lo) * length / step) + 1)))
    t = np.linspace(t_lo, t_hi, count)
    # The parameter interval is already clipped to the survey rectangle.
    # Floating arithmetic can still put an edge point a few ulps outside it
    # (e.g. crossline 309.99999999999994 instead of 310), which both samplers
    # would correctly reject as out of bounds. Keep those boundary traces.
    qil = np.clip(ail + d_il * t, il_lo, il_hi)
    qxl = np.clip(axl + d_xl * t, xl_lo, xl_hi)
    # Measured from the section start so the axis is strictly increasing
    # (a Plotly heatmap needs monotonic x); A and B sit inside it.
    distance = np.hypot(qil - qil[0], qxl - qxl[0])

    path_key = ("ab-native", ail, axl, bil, bxl, count)
    native = survey.cache.get(path_key)
    if native is None:
        native = sample_seismic_line(survey, qil, qxl).T
        survey.cache[path_key] = native
    else:
        survey.cache.move_to_end(path_key)
    view = display_state or ViewState(section_number=0, seismic=Seismic(clip_percentile=99))
    trace_amplitudes, lo, hi = amplitude(native, view.seismic)
    display = section_raster(survey, distance, survey.times, native, view,
                             target_width, target_height, cache_id=path_key)
    display_distance, display_time = display["x"], display["time"]
    # Interpretations keep the fixed original path coordinates. Background
    # pixels and interpolation switches never rebuild horizon curve geometry.
    curves = []
    for key, h in (horizons or {}).items():
        hx, hy, hgrid = horizon_grid(h)
        curves.append(
            dict(
                id=key,
                name=h.name,
                values=_bilinear_points(hx, hy, hgrid, qxl, qil),
            )
        )
    return dict(
        # Resampled coordinate axes, matching the display raster exactly.
        distance=display_distance,
        time=display_time,
        # Time-major rows so both the heatmap and matplotlib consume z directly.
        amplitude=display["values"],
        distance_edges=display["x_edges"], time_edges=display["time_edges"],
        raster_extent=display["extent"],
        native_distance=distance, native_time=survey.times, native_amplitude=native,
        trace_amplitudes=trace_amplitudes,
        trace_overlay=build_trace_overlay(distance, survey.times, trace_amplitudes, view, lo, hi)
            if overlays_enabled(view.seismic) else None,
        view=view,
        curves=curves,
        curve_distance=distance,
        a_distance=float(round(np.hypot(ail - qil[0], axl - qxl[0]), 3)),
        b_distance=float(round(np.hypot(bil - qil[0], bxl - qxl[0]), 3)),
        # Full extended path ends, so the map can draw what the section covers.
        path_start=[float(qil[0]), float(qxl[0])],
        path_end=[float(qil[-1]), float(qxl[-1])],
        vmin=lo, vmax=hi,
        method=display["interpolation"],
        native_shape=display["native_shape"], preview_shape=display["preview_shape"],
        resampled=display["preview_shape"] != display["native_shape"],
        label_y="Time (ms)",
    )


def map_profile(
    survey,
    horizon,
    state,
    horizons,
    a,
    b,
    target_width=None,
    target_height=None,
    interpolation=None,
    display_state=None,
):
    """Serialized A–B section for the web profile subplot."""
    d = _profile_data(survey, state, horizons, a, b, target_width, target_height, interpolation, display_state)
    return dict(
        distance=d["distance"].tolist(),
        time=[float(v) for v in d["time"]],
        amplitude=serial(d["amplitude"]),
        distance_edges=d["distance_edges"].tolist(), time_edges=d["time_edges"].tolist(),
        raster_extent=list(d["raster_extent"]),
        native_shape=d["native_shape"], preview_shape=d["preview_shape"],
        interpolation=d["method"],
        background_interpolation=d["view"].seismic.background_interpolation,
        wiggle_interpolation=d["view"].seismic.wiggle_interpolation,
        trace_overlay=d["trace_overlay"],
        x_range=[float(d["native_distance"][0]), float(d["native_distance"][-1])],
        time_range=[float(d["native_time"][0]), float(d["native_time"][-1])],
        curves=[
            dict(id=c["id"], name=c["name"], values=serial(c["values"]))
            for c in d["curves"]
        ],
        curve_distance=d["curve_distance"].tolist(),
        a_distance=d["a_distance"],
        b_distance=d["b_distance"],
        path_start=d["path_start"],
        path_end=d["path_end"],
        vmin=d["vmin"],
        vmax=d["vmax"],
        label_y=d["label_y"],
    )


def render_profile(
    survey,
    state,
    horizons,
    a,
    b,
    settings,
    curve_colors=None,
    colormap="seismic",
    reverse_colormap=False,
    show_curves=True,
    show_legend=True,
    show_ab=True,
    display_state=None,
    horizon_styles=None,
):
    """Publication A–B section: interpolated seismic background, horizon Time
    overlays in their style colors, A/B markers.  Returns ``(bytes, info)``.
    """
    from backend.style import get_cmap, font_family

    view = display_state or ViewState(section_number=0, seismic=Seismic(
        colormap=colormap, reverse_colormap=reverse_colormap, clip_percentile=99,
    ))
    # Use native cells as a layout placeholder; publication reconstructs once
    # at the final axes pixels with the same Sinc8 kernel as the viewer.
    layout_view = view.model_copy(update={"seismic": view.seismic.model_copy(update={"background_interpolation": False})})
    d = _profile_data(survey, state, horizons, a, b, display_state=layout_view)
    d["view"] = view
    ratio = view.aspect_ratio_2d[0] / view.aspect_ratio_2d[1] if view.aspect_ratio_2d else d["amplitude"].shape[1] / d["amplitude"].shape[0]
    fig = Figure(
        figsize=figure_size(settings, ratio),
        dpi=settings.dpi,
        layout="constrained",
    )
    ax = fig.subplots()
    if view.aspect_ratio_2d or settings.canvas == "fit":
        ax.set_box_aspect(1 / ratio)
    from backend.trace_overlay import reconstruction_extent
    extent = reconstruction_extent(d["native_distance"], d["native_time"], view.x_range, view.time_range)
    cmap = get_cmap(view.seismic.colormap, view.seismic.reverse_colormap)
    values = -d["amplitude"] if view.seismic.reverse_polarity else d["amplitude"]
    rasters = []
    if view.seismic.background_interpolation:
        image = ax.imshow(values, extent=extent, aspect="auto", cmap=cmap,
                          vmin=d["vmin"], vmax=d["vmax"], origin="lower",
                          interpolation="none", rasterized=True, zorder=0)
        sampler = lambda width, height: _publication_raster(
            d["native_distance"], d["native_time"], d["trace_amplitudes"], width, height, extent,
        )
        rasters = [(image, values, sampler)]
    else:
        ax.pcolormesh(d["distance_edges"], d["time_edges"], values, shading="flat",
                      cmap=cmap, vmin=d["vmin"], vmax=d["vmax"],
                      edgecolors="none", antialiased=False, rasterized=True, zorder=0)
    overlay = d["trace_overlay"]
    if overlay and view.seismic.variable_area:
        ax.add_collection(PolyCollection(_path_segments(overlay["variable_area"]),
            facecolors=view.seismic.variable_area_color, edgecolors="none", antialiaseds=True, zorder=1), autolim=False)
    if overlay and view.seismic.wiggle:
        ax.add_collection(LineCollection(_path_segments(overlay["wiggle"]),
            colors="#000000", linewidths=WIGGLE_WIDTH, antialiaseds=True, zorder=2), autolim=False)
    ax.set_axisbelow(False)
    ax.xaxis.set_zorder(4)
    ax.yaxis.set_zorder(4)
    for spine in ax.spines.values():
        spine.set_zorder(4)
    colors = curve_colors or {}
    styles = None if horizon_styles is None else {h.id: h for h in horizon_styles if h.visible}
    drawn = []
    if show_curves:
        for curve in d["curves"]:
            if styles is not None:
                if curve["id"] not in styles:
                    continue
                if not draw_horizon(ax, np.column_stack((d["curve_distance"], curve["values"])),
                                    styles[curve["id"]], label=curve["name"]):
                    continue
            else:
                ax.plot(d["curve_distance"], curve["values"], color=colors.get(curve["id"], "#1a1a1a"),
                        lw=1.8, label=curve["name"], zorder=3)
            drawn.append(curve["name"])
    if show_ab:
        for x in (d["a_distance"], d["b_distance"]):
            ax.axvline(x, color="#1a1a1a", lw=1.2, ls=(0, (4, 3)), zorder=4)
        top = float(d["time"][0])
        span = float(d["time"][-1]) - top
        for x, text in ((d["a_distance"], "A"), (d["b_distance"], "B")):
            ax.text(
                x,
                top + 0.02 * span,
                f" {text}",
                color="#1a1a1a",
                fontsize=settings.font_size,
                ha="left",
                va="top",
            )
    ax.set_xlim(view.x_range or (float(d["native_distance"][0]), float(d["native_distance"][-1])))
    tr = view.time_range or (float(d["native_time"][0]), float(d["native_time"][-1]))
    ax.set_ylim(max(tr), min(tr))
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel("Distance (grid)")
        ax.set_ylabel("Time (ms)")
    if show_curves and show_legend and drawn:
        ax.legend(loc="lower right", fontsize=settings.font_size, framealpha=0.85)
    if settings.show_title:
        ax.set_title("A–B Profile")
    colorbars = []
    if state.colorbar:
        norm = Normalize(d["vmin"], d["vmax"])
        cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), ax=ax)
        cb.set_label("Amplitude")
        cb.solids.set_rasterized(False)
        colorbars.append((cb, ax))
    from matplotlib.text import Text

    for text in fig.findobj(Text):
        text.set_fontfamily(font_family(settings.font))
        text.set_fontsize(settings.font_size)
    content = save_figure(fig, settings, rasters, colorbars)
    info = dict(
        a=list(a) if not isinstance(a, (list, tuple)) else [float(a[0]), float(a[1])],
        b=[float(b[0]), float(b[1])],
        a_distance=d["a_distance"],
        b_distance=d["b_distance"],
        path_start=d["path_start"],
        path_end=d["path_end"],
        curves=drawn,
        vmax=d["vmax"],
        vmin=d["vmin"],
    )
    return content, info


def map_scalar(survey, horizon, state, horizons=None) -> HorizonMapData:
    """Build the geometry/scalar pair selected by ``state.color_by``."""
    x, y, twt = horizon_grid(horizon)
    if state.color_by == "amplitude":
        if survey is None:
            raise ValueError("Seismic amplitude needs a loaded SEG-Y survey.")
        scalar = sample_amplitude(survey, horizon, x, y, twt)
        name, unit, label = "Amplitude", "", "Amplitude"
    elif state.color_by == "difference":
        scalar = sample_difference(horizon, state, horizons)
        if state.difference_type == "absolute":
            name, unit, label = "|Difference|", "ms", "|ΔTime| (ms)"
        else:
            name, unit, label = "Difference", "ms", "ΔTime (ms)"
    else:
        scalar = twt
        name, unit, label = "Time", "ms", "Time (ms)"
    return HorizonMapData(x=x, y=y, twt=twt, scalar=scalar, name=name, unit=unit, label=label)


def map_values(survey, horizon, state, horizons=None):
    """Return ``(data, lo, hi, vmin, vmax, cmap, levels)`` for preview and render."""
    data = map_scalar(survey, horizon, state, horizons)
    values = data.scalar[data.valid]
    if len(values):
        lo, hi = float(np.min(values)), float(np.max(values))
    else:
        lo, hi = 0.0, 1.0
    if state.range_mode == "auto":
        if state.color_by == "amplitude" or (
            state.color_by == "difference" and state.difference_type == "signed"
        ):
            # Symmetric around zero: -percentile(|s|) ... 0 ... +percentile(|s|).
            vmax = float(np.percentile(np.abs(values), state.clip_percentile)) if len(values) else 0.0
            vmax = vmax or 1.0
            vmin = -vmax
        elif state.color_by == "difference":
            # Absolute difference grows from zero.
            vmax = float(np.percentile(values, state.clip_percentile)) if len(values) else 0.0
            vmax = vmax or 1.0
            vmin = 0.0
        else:
            vmin, vmax = lo, hi
    else:
        vmin, vmax = state.vmin, state.vmax
    if vmin == vmax:
        vmin, vmax = vmin - 0.5, vmax + 0.5
    cmap = (
        LinearSegmentedColormap.from_list("petrel", PETREL, N=256)
        if state.colormap == "petrel"
        else colormaps[state.colormap]
    )
    if state.reverse_colormap:
        cmap = cmap.reversed()
    levels = np.array([])
    if state.contours and state.display != "filled" and lo < hi:
        interval = state.interval
        if interval is None:
            # A 1/2/5 step covering ~20 contours of the active scalar range,
            # so switching scalars never explodes into thousands of lines.
            raw = (hi - lo) / 20
            magnitude = 10.0 ** np.floor(np.log10(raw))
            interval = next(m * magnitude for m in (1, 2, 5, 10) if raw <= m * magnitude)
        start = np.ceil(lo / interval) * interval
        count = int(np.floor((hi - start) / interval)) + 1
        if count > 500:
            raise ValueError("Too many contours; increase the interval (maximum 500 levels).")
        levels = start + np.arange(max(0, count)) * interval
    return data, lo, hi, vmin, vmax, cmap, levels


def map_data(survey, horizon, state, horizons=None):
    data, lo, hi, vmin, vmax, cmap, levels = map_values(survey, horizon, state, horizons)
    paths = []
    if len(data.x) > 1 and len(data.y) > 1 and len(levels):
        generator = contourpy.contour_generator(x=data.x, y=data.y, z=np.ma.masked_invalid(data.scalar), corner_mask=False)
        for level in levels:
            for points in generator.lines(float(level)):
                paths.append(dict(level=float(level), x=points[:, 0].tolist(), y=points[:, 1].tolist()))
    payload = dict(
        x=data.x.tolist(),
        y=data.y.tolist(),
        z=serial(data.scalar),
        color_by=state.color_by,
        scalar_name=data.name,
        scalar_unit=data.unit,
        colorbar_title=data.label,
        # Always the horizon's own Time extent, whatever the color scalar is.
        twt_range=[float(np.nanmin(data.twt)), float(np.nanmax(data.twt))],
        vmin=vmin,
        vmax=vmax,
        colorscale=[[i / 255, to_hex(cmap(i / 255))] for i in range(256)],
        contours=paths,
    )
    if state.color_by == "difference":
        # Statistics always describe the signed difference, whatever is drawn.
        payload["statistics"] = difference_statistics(_signed_difference(horizon, state, horizons))
    return payload


def render_map(survey, horizon, state, settings, horizons=None, profile=None):
    data, lo, hi, vmin, vmax, cmap, levels = map_values(survey, horizon, state, horizons)
    xr = state.x_range or [float(data.x[0]) - .5, float(data.x[-1]) + .5]
    yr = state.y_range or [float(data.y[0]) - .5, float(data.y[-1]) + .5]
    ratio = abs(xr[1] - xr[0]) / max(abs(yr[1] - yr[0]), 1e-9)
    fig = Figure(figsize=figure_size(settings, ratio), dpi=settings.dpi, layout='constrained')
    ax = fig.subplots()
    norm = Normalize(vmin, vmax, clip=True)
    masked = np.ma.masked_invalid(data.scalar)
    if state.display != 'contour':
        ax.pcolormesh(data.x, data.y, masked, shading='nearest', cmap=cmap, norm=norm, rasterized=True)
    if len(data.x) > 1 and len(data.y) > 1 and len(levels):
        cs = ax.contour(data.x, data.y, masked, levels=levels, colors='#333333', linewidths=state.line_width, corner_mask=False)
        if state.labels:
            ax.clabel(cs, inline=True, fmt='%g', fontsize=settings.font_size)
    ax.set_aspect('equal', adjustable='box')
    ax.set_xlim(state.x_range or [float(data.x[0]) - .5, float(data.x[-1]) + .5])
    ax.set_ylim(state.y_range or [float(data.y[0]) - .5, float(data.y[-1]) + .5])
    if profile is not None:
        color = "#1a1a1a"
        for index, (start, end) in enumerate(((profile.path_start, profile.a), (profile.b, profile.path_end))):
            if start is not None and end is not None:
                extension, = ax.plot([start[1], end[1]], [start[0], end[0]],
                                     color=color, lw=1.125, ls=":", zorder=5)
                extension.set_gid(f"map-ab-extension-{index}")
        line, = ax.plot([profile.a[1], profile.b[1]], [profile.a[0], profile.b[0]],
                        color=color, lw=1.5, ls="--", marker="o", ms=5.25, zorder=5)
        line.set_gid("map-ab-line")
        for label, (il, xl) in (("A", profile.a), ("B", profile.b)):
            annotation = ax.annotate(label, (xl, il), xytext=(3, 3), textcoords="offset points",
                                    ha="left", va="bottom", color=color, clip_on=True, zorder=6)
            annotation.set_gid(f"map-ab-label-{label.lower()}")
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel('Crossline'); ax.set_ylabel('Inline')
    if settings.show_title:
        if state.color_by == "difference":
            reference, comparison = difference_horizons(state, horizons)
            expression = f"{comparison.name} − {reference.name}"
            title = (
                f"Absolute Difference: |{expression}|"
                if state.difference_type == "absolute"
                else f"Signed Difference: {expression}"
            )
            ax.set_title(title)
        else:
            ax.set_title(horizon.name)
    colorbars = []
    if state.colorbar:
        cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), ax=ax)
        cb.set_label(data.label)
        cb.solids.set_rasterized(False)
        colorbars.append((cb, ax))
    from matplotlib.text import Text
    for text in fig.findobj(Text):
        text.set_fontfamily(font_family(settings.font))
        text.set_fontsize(settings.font_size)
    bare_map = not (settings.show_axes or settings.show_title or state.colorbar)
    return save_figure(fig, settings, colorbars=colorbars, padding=0 if bare_map else 0.07)
