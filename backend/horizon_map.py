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


def map_scalar(survey, horizon, state) -> HorizonMapData:
    """Build the geometry/scalar pair selected by ``state.color_by``."""
    x, y, twt = horizon_grid(horizon)
    if state.color_by == "amplitude":
        if survey is None:
            raise ValueError("Seismic amplitude needs a loaded SEG-Y survey.")
        scalar = sample_amplitude(survey, horizon, x, y, twt)
        name, unit, label = "Amplitude", "", "Amplitude"
    else:
        scalar = twt
        name, unit, label = "TWT", "ms", "TWT (ms)"
    return HorizonMapData(x=x, y=y, twt=twt, scalar=scalar, name=name, unit=unit, label=label)


def map_values(survey, horizon, state):
    """Return ``(data, lo, hi, vmin, vmax, cmap, levels)`` for preview and render."""
    data = map_scalar(survey, horizon, state)
    values = data.scalar[data.valid]
    if len(values):
        lo, hi = float(np.min(values)), float(np.max(values))
    else:
        lo, hi = 0.0, 1.0
    if state.range_mode == "auto":
        if state.color_by == "amplitude":
            # Symmetric around zero: -percentile(|A|) ... 0 ... +percentile(|A|).
            vmax = float(np.percentile(np.abs(values), state.clip_percentile)) if len(values) else 0.0
            vmax = vmax or 1.0
            vmin = -vmax
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


def map_data(survey, horizon, state):
    data, lo, hi, vmin, vmax, cmap, levels = map_values(survey, horizon, state)
    paths = []
    if len(data.x) > 1 and len(data.y) > 1 and len(levels):
        generator = contourpy.contour_generator(x=data.x, y=data.y, z=np.ma.masked_invalid(data.scalar), corner_mask=False)
        for level in levels:
            for points in generator.lines(float(level)):
                paths.append(dict(level=float(level), x=points[:, 0].tolist(), y=points[:, 1].tolist()))
    return dict(
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


def render_map(survey, horizon, state, settings):
    data, lo, hi, vmin, vmax, cmap, levels = map_values(survey, horizon, state)
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
