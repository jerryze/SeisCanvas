"""Horizon maps: geometry/color-scalar separation, contours and publication render.

The map geometry is always Inline/Crossline/TWT; the color scalar is selected by
``HorizonMapState.color_by`` (horizon TWT today, seismic amplitude sampled along
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
from matplotlib.cm import ScalarMappable
from backend.models import HorizonMapExport, HorizonMapState
from backend.preview import preview_ids, read_samples
from backend.scene import horizon_grid, serial
from backend.style import font_family

__all__ = [
    "HorizonMapData",
    "map_scalar",
    "map_values",
    "map_data",
    "render_map",
    "sample_amplitude",
    "sample_difference",
    "resample_to_grid",
    "difference_statistics",
]

PETREL = ['#ff0000', '#ff8000', '#ffff00', '#00c040', '#00ffff', '#0000ff', '#8000c0', '#ff00ff']


@dataclass
class HorizonMapData:
    """Horizon geometry plus the active color scalar (horizon_map_v2 §22)."""

    x: np.ndarray          # crossline axis
    y: np.ndarray          # inline axis
    twt: np.ndarray        # TWT grid (ms), NaN where unpicked
    scalar: np.ndarray     # active color scalar, NaN = invalid
    name: str              # "TWT" / "Amplitude"
    unit: str              # "ms" / ""
    label: str             # colorbar caption, e.g. "TWT (ms)"

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


def _signed_difference(horizon, state, horizons):
    """Comparison minus reference, bilinearly resampled onto this grid.

    Geometry comes from the currently selected horizon, so grids with
    different spacing still line up.  The result only depends on the horizon
    pair, so it is cached on the geometry horizon like the other lazy grids.
    """
    if not horizons:
        raise ValueError("Difference needs the loaded horizons.")
    reference = horizons.get(state.difference_reference or "")
    comparison = horizons.get(state.difference_comparison or "")
    if reference is None or comparison is None:
        raise ValueError("Difference needs a reference and a comparison horizon.")
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
            name, unit, label = "|Difference|", "ms", "|ΔTWT| (ms)"
        else:
            name, unit, label = "Difference", "ms", "ΔTWT (ms)"
    else:
        scalar = twt
        name, unit, label = "TWT", "ms", "TWT (ms)"
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
        # Always the horizon's own TWT extent, whatever the color scalar is.
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


def render_map(survey, horizon, state, settings, horizons=None):
    data, lo, hi, vmin, vmax, cmap, levels = map_values(survey, horizon, state, horizons)
    fig = Figure(figsize=(settings.width / 25.4, settings.height / 25.4), dpi=settings.dpi, layout='constrained')
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
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel('Crossline'); ax.set_ylabel('Inline')
    if settings.show_title:
        ax.set_title(horizon.name)
    if state.colorbar:
        cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), ax=ax)
        cb.set_label(data.label)
        cb.solids.set_rasterized(False)
    from matplotlib.text import Text
    for text in fig.findobj(Text):
        text.set_fontfamily(font_family(settings.font))
        text.set_fontsize(settings.font_size)
    out = io.BytesIO()
    fig.savefig(out, format=settings.format, dpi=settings.dpi)
    return out.getvalue()
