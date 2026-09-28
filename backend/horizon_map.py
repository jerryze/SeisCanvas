"""Horizon TWT map: native grid values, contour extraction and publication render.

The map's request schemas (``HorizonMapState``/``HorizonMapExport``) live in
``backend.models`` like every other API model; they are re-exported here for
backward compatibility.
"""
import io
import numpy as np
import contourpy
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap, Normalize, to_hex
from matplotlib.figure import Figure
from matplotlib.cm import ScalarMappable
from backend.models import HorizonMapExport, HorizonMapState
from backend.style import font_family
from backend.scene import horizon_grid, serial

__all__ = ["HorizonMapState", "HorizonMapExport", "map_values", "map_data", "render_map"]

PETREL = ['#ff0000', '#ff8000', '#ffff00', '#00c040', '#00ffff', '#0000ff', '#8000c0', '#ff00ff']

def map_values(horizon, state):
    x, y, grid = horizon_grid(horizon)
    lo, hi = float(np.nanmin(grid)), float(np.nanmax(grid))
    vmin, vmax = (lo, hi) if state.range_mode == 'auto' else (state.vmin, state.vmax)
    if vmin == vmax:
        vmin, vmax = vmin - .5, vmax + .5
    cmap = LinearSegmentedColormap.from_list('petrel', PETREL, N=256) if state.colormap == 'petrel' else colormaps[state.colormap]
    if state.reverse_colormap:
        cmap = cmap.reversed()
    levels = np.array([])
    if state.contours and state.display != 'filled' and lo < hi:
        start = np.ceil(lo / state.interval) * state.interval
        count = int(np.floor((hi - start) / state.interval)) + 1
        if count > 500:
            raise ValueError('Too many contours; increase the interval (maximum 500 levels).')
        levels = start + np.arange(max(0, count)) * state.interval
    return x, y, grid, lo, hi, vmin, vmax, cmap, levels

def map_data(horizon, state):
    x, y, grid, lo, hi, vmin, vmax, cmap, levels = map_values(horizon, state)
    paths = []
    if len(x) > 1 and len(y) > 1 and len(levels):
        generator = contourpy.contour_generator(x=x, y=y, z=np.ma.masked_invalid(grid), corner_mask=False)
        for level in levels:
            for points in generator.lines(float(level)):
                paths.append(dict(level=float(level), x=points[:, 0].tolist(), y=points[:, 1].tolist()))
    return dict(x=x.tolist(), y=y.tolist(), z=serial(grid), twt_range=[lo, hi],
                vmin=vmin, vmax=vmax, colorscale=[[i/255, to_hex(cmap(i/255))] for i in range(256)], contours=paths)

def render_map(horizon, state, settings):
    x, y, grid, lo, hi, vmin, vmax, cmap, levels = map_values(horizon, state)
    fig = Figure(figsize=(settings.width/25.4, settings.height/25.4), dpi=settings.dpi, layout='constrained')
    ax = fig.subplots()
    norm = Normalize(vmin, vmax, clip=True)
    masked = np.ma.masked_invalid(grid)
    if state.display != 'contour':
        ax.pcolormesh(x, y, masked, shading='nearest', cmap=cmap, norm=norm, rasterized=True)
    if len(x) > 1 and len(y) > 1 and len(levels):
        cs = ax.contour(x, y, masked, levels=levels, colors='#333333', linewidths=state.line_width, corner_mask=False)
        if state.labels:
            ax.clabel(cs, inline=True, fmt='%g', fontsize=settings.font_size)
    ax.set_aspect('equal', adjustable='box')
    ax.set_xlim(state.x_range or [float(x[0])-.5, float(x[-1])+.5])
    ax.set_ylim(state.y_range or [float(y[0])-.5, float(y[-1])+.5])
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel('Crossline'); ax.set_ylabel('Inline')
    if settings.show_title:
        ax.set_title(horizon.name)
    if state.colorbar:
        cb = fig.colorbar(ScalarMappable(norm=norm, cmap=cmap), ax=ax)
        cb.set_label('TWT (ms)')
        cb.solids.set_rasterized(False)
    from matplotlib.text import Text
    for text in fig.findobj(Text):
        text.set_fontfamily(font_family(settings.font))
        text.set_fontsize(settings.font_size)
    out = io.BytesIO()
    fig.savefig(out, format=settings.format, dpi=settings.dpi)
    return out.getvalue()
