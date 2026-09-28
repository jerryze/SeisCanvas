"""Horizon TWT map shared state, native grid preview and publication renderer."""
import io
import numpy as np
import contourpy
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap, Normalize, to_hex
from matplotlib.figure import Figure
from matplotlib.cm import ScalarMappable
from pydantic import Field, model_validator
from typing import Literal
from backend.models import BaseModel, Settings
from backend.scene import horizon_grid, serial

PETREL = ['#ff0000', '#ff8000', '#ffff00', '#00c040', '#00ffff', '#0000ff', '#8000c0', '#ff00ff']

class HorizonMapState(BaseModel):
    horizon: str
    display: Literal['filled', 'contour', 'filled_contour'] = 'filled_contour'
    colormap: Literal['petrel', 'turbo', 'viridis', 'cividis', 'jet'] = 'petrel'
    reverse_colormap: bool = False
    range_mode: Literal['auto', 'manual'] = 'auto'
    vmin: float | None = None
    vmax: float | None = None
    contours: bool = True
    interval: float = Field(10, gt=0)
    line_width: float = Field(.5, ge=.1, le=6)
    labels: bool = False
    colorbar: bool = True
    x_range: tuple[float, float] | None = None
    y_range: tuple[float, float] | None = None

    @model_validator(mode='after')
    def ranges(self):
        if self.range_mode == 'manual' and (self.vmin is None or self.vmax is None or self.vmin >= self.vmax):
            raise ValueError('Manual minimum must be less than maximum.')
        for r in [self.x_range, self.y_range]:
            if r and r[0] >= r[1]:
                raise ValueError('Axis range must be increasing.')
        return self

class HorizonMapExport(BaseModel):
    state: HorizonMapState
    settings: Settings

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
        text.set_fontfamily(settings.font)
        text.set_fontsize(settings.font_size)
    out = io.BytesIO()
    fig.savefig(out, format=settings.format, dpi=settings.dpi)
    return out.getvalue()
