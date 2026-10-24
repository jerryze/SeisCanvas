"""Publication 2D rendering: matplotlib figures assembled from survey sections."""

from dataclasses import dataclass

import numpy as np
from matplotlib.figure import Figure
from matplotlib.collections import LineCollection, PolyCollection
from backend import resample
from backend.figure_export import figure_size, save_figure
from backend.horizon_display import sg_section, pchip_display
from backend.style import get_cmap, font_family
from backend.slice_source import polarity, read_window, section_input, source_limits
from backend.trace_overlay import (
    DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH, WIGGLE_WIDTH,
    build_trace_overlay, coordinate_cell_edges, coordinate_edges, overlays_enabled, reconstruction_extent,
)

#: A viewer-sized render grid, used when an export reuses the view resolution.
VIEW_TARGET = (1600, 1000)
#: Legacy compatibility export; 2D Sinc rendering is bounded by pixels instead.
EXPORT_MAX_UPSCALE = 32.0


def window_indices(coordinates, span):
    """Inclusive index window covering a world-coordinate span (one sample of slack)."""
    if span is None:
        return 0, len(coordinates) - 1
    low, high = min(span), max(span)
    start = int(np.searchsorted(coordinates, low, side="left")) - 1
    stop = int(np.searchsorted(coordinates, high, side="right")) + 1
    start = max(0, min(start, len(coordinates) - 1))
    stop = max(start + 1, min(stop, len(coordinates)))
    return start, stop - 1


def display_raster(x, time, z, state, settings):
    """Resample the visible part of a section for drawing.

    Returns ``(raster, extent, source_shape)``.  The raster only exists for the
    renderer: the returned extent still maps onto the original sample centres,
    so horizons, axes and hover keep using real world coordinates.
    """
    x0, x1 = window_indices(x, state.x_range)
    t0, t1 = window_indices(time, state.time_range)
    native_height, native_width = t1 - t0 + 1, x1 - x0 + 1
    x_edges, t_edges = coordinate_cell_edges(x), coordinate_cell_edges(time)
    extent = (float(x_edges[x0]), float(x_edges[x1 + 1]), float(t_edges[t0]), float(t_edges[t1 + 1]))
    if not state.seismic.background_interpolation:
        window = read_window(z, slice(t0, t1 + 1), slice(x0, x1 + 1))
        return window, extent, (native_width, native_height)
    extent = reconstruction_extent(x, time, state.x_range, state.time_range)
    if settings.resolution == "view":
        width = int(state.trace_viewport_width or DEFAULT_VIEWPORT_WIDTH)
        height = int(state.trace_viewport_height or DEFAULT_VIEWPORT_HEIGHT)
        budget = resample.INTERACTIVE_BUDGET
    else:
        width, height = settings.canvas_pixels()
        budget = resample.MAX_RENDER_PIXELS
    width, height = resample.fit_target(
        native_width, native_height, width, height, budget=budget,
        max_upscale=max(width / native_width, height / native_height, 1.0),
    )
    raster, _, _, _ = resample.seismic_raster(x, time, z, width, height, extent)
    return raster, extent, (native_width, native_height)


def amplitude(z, s):
    if hasattr(z, "iter_blocks"):
        lo, hi = source_limits([z], s)
        return polarity(z, s.reverse_polarity), lo, hi
    z = -z if s.reverse_polarity else z
    if s.clip_mode == "manual":
        if s.vmin is None or s.vmax is None or s.vmin >= s.vmax:
            raise ValueError("Manual amplitude minimum must be less than maximum.")
        lo, hi = s.vmin, s.vmax
    else:
        # Survey data is normally finite; avoid copying that full section.
        finite = z if np.isfinite(z).all() else z[np.isfinite(z)]
        if not finite.size:
            finite = np.array([0.0])
        if s.symmetric:
            hi = float(np.percentile(np.abs(finite), s.clip_percentile)) or 1.0
            lo = -hi
        else:
            tail = (100 - s.clip_percentile) / 2
            lo, hi = np.percentile(finite, [tail, 100 - tail]).tolist()
            if hi == lo:
                lo, hi = lo - 1, hi + 1
    return z, lo, hi


def _path_segments(path):
    """Convert shared JSON paths to vector collection segments."""
    segments, points = [], []
    for x, time in zip(path["x"], path["time"]):
        if x is None or time is None:
            if points:
                segments.append(points)
                points = []
        else:
            points.append((x, time))
    if points:
        segments.append(points)
    return segments


def _publication_raster(x, time, amplitudes, width, height, extent):
    """Bound the raster while preserving valid wide physical page dimensions."""
    width, height = resample.fit_target(
        len(x), len(time), width, height, budget=resample.MAX_RENDER_PIXELS,
        max_upscale=max(width / len(x), height / len(time), 1.0),
    )
    return resample.seismic_raster(x, time, amplitudes, width, height, extent)[0]


def draw_horizon(ax, points, style, zorder=3, label=None, display_points=None):
    """Shared 2D/A–B horizon furniture, independent of amplitude sampling."""
    if not len(points) or not style.visible:
        return False
    line = style.line.visible and style.line.style != "none"
    marker = style.marker.visible and style.marker.shape != "none"
    dash = {"solid": "-", "dashed": "--", "dotted": ":", "dashdot": "-."}
    markers = {"circle": "o", "circle-open": "o", "square": "s", "triangle": "^", "diamond": "D", "cross": "x", "plus": "+"}
    curve = points if display_points is None else display_points
    if line:
        if style.outline.enabled:
            ax.plot(curve[:, 0], curve[:, 1], color="black",
                    lw=style.line.width + 2 * style.outline.width,
                    ls=dash[style.line.style], zorder=zorder)
        ax.plot(curve[:, 0], curve[:, 1], color=style.color, lw=style.line.width,
                ls=dash[style.line.style], zorder=zorder, label=label)
    if marker:
        hollow = style.marker.shape == "circle-open"
        ax.plot(points[:, 0], points[:, 1], ls="none", marker=markers[style.marker.shape],
                ms=style.marker.size, color=style.color,
                markerfacecolor="white" if hollow else style.color,
                markeredgecolor=style.color if hollow or not style.outline.enabled else "black",
                markeredgewidth=max(.75, style.outline.width if style.outline.enabled else 0) if hollow
                    else style.outline.width if style.outline.enabled else 0,
                zorder=zorder, label=label if not line else None)
    return line or marker


@dataclass(frozen=True)
class SectionRenderResult:
    data: bytes
    colorbar_range: tuple[float, float]


def render(survey, horizons, state, settings) -> bytes:
    """Compatibility entry point for callers that only need the figure bytes."""
    return render_with_metadata(survey, horizons, state, settings).data


def render_with_metadata(survey, horizons, state, settings) -> SectionRenderResult:
    """Render once and report the exact native amplitude range used to draw it."""
    x, t, z = section_input(survey, state.view_type, state.section_number)
    # Amplitude clipping always comes from the original section: the colour
    # range must not change with the interpolation mode or the zoom window.
    z, lo, hi = amplitude(z, state.seismic)
    trace_display = overlays_enabled(state.seismic)
    x0, x1 = window_indices(x, state.x_range)
    t0, t1 = window_indices(t, state.time_range)
    native_shape = (t1 - t0 + 1, x1 - x0 + 1)
    # The first draw only establishes layout. Explicit world extent and colour
    # limits make a tiny placeholder sufficient until final pixel sampling.
    native = (np.zeros((1, 1), dtype=z.dtype) if state.seismic.background_interpolation
              else read_window(z, slice(t0, t1 + 1), slice(x0, x1 + 1)))
    x_edges = coordinate_cell_edges(x)[x0:x1 + 2]
    t_edges = coordinate_cell_edges(t)[t0:t1 + 2]
    extent = (float(x_edges[0]), float(x_edges[-1]), float(t_edges[0]), float(t_edges[-1]))
    if state.seismic.background_interpolation:
        extent = reconstruction_extent(x, t, state.x_range, state.time_range)
    ratio = (state.aspect_ratio_2d[0] / state.aspect_ratio_2d[1]
             if state.aspect_ratio_2d else native_shape[1] / native_shape[0])
    fig = Figure(
        figsize=figure_size(settings, ratio),
        dpi=settings.dpi,
        layout="constrained",
    )
    ax = fig.subplots()
    if state.aspect_ratio_2d is not None:
        horizontal, vertical = state.aspect_ratio_2d
        ax.set_box_aspect(vertical / horizontal)
    if settings.canvas == "fit":
        ax.set_box_aspect(1 / ratio)
    cmap = get_cmap(state.seismic.colormap, state.seismic.reverse_colormap)
    rasters = []
    if state.seismic.background_interpolation:
        # Native data is only a layout placeholder. Once axes size is known,
        # the sampler reconstructs amplitudes directly to final output pixels.
        image = ax.imshow(native, cmap=cmap, vmin=lo, vmax=hi, extent=extent,
                          origin="lower", aspect="auto", interpolation="none",
                          rasterized=True, zorder=0)
        sampler = lambda width, height: _publication_raster(x, t, z, width, height, extent)
        rasters = [(image, native, sampler)]
    else:
        # Rasterized cells retain every original value and irregular boundary;
        # no image resizing, smoothing, or colour-space interpolation occurs.
        ax.pcolormesh(x_edges, t_edges, native, cmap=cmap, vmin=lo, vmax=hi,
                      shading="flat", edgecolors="none", antialiased=False,
                      rasterized=True, zorder=0)
    if trace_display:
        overlay = build_trace_overlay(x, t, z, state, lo, hi)
        if state.seismic.variable_area:
            ax.add_collection(PolyCollection(
                _path_segments(overlay["variable_area"]),
                facecolors=state.seismic.variable_area_color,
                edgecolors="none", linewidths=0, antialiaseds=True, zorder=1,
            ), autolim=False)
        if state.seismic.wiggle:
            ax.add_collection(LineCollection(
                _path_segments(overlay["wiggle"]),
                colors="#000000", linewidths=WIGGLE_WIDTH, antialiaseds=True, zorder=2,
            ), autolim=False)
        # Axes furniture is drawn last; overlays always sit below horizons.
        ax.set_axisbelow(False)
        ax.xaxis.set_zorder(4)
        ax.yaxis.set_zorder(4)
        for spine in ax.spines.values():
            spine.set_zorder(4)
    for h in state.horizons:
        if h.visible and h.id in horizons:
            points = np.asarray(horizons[h.id].section(state.view_type, state.section_number))
            curve = None
            if state.horizon_sg:
                curve = sg_section(horizons[h.id], state.view_type, state.section_number,
                                   state.horizon_sg_window, x, points)
                if state.smooth_horizons:
                    curve = pchip_display(curve, state.x_range or coordinate_edges(x),
                                          settings.canvas_pixels()[0] if settings.canvas == "fixed" else settings.long_edge)
            draw_horizon(ax, points, h, 3 if trace_display else 2, display_points=curve)
    ax.set_xlim(state.x_range or coordinate_edges(x))
    tr = state.time_range or [float(t[0]), float(t[-1])]
    ax.set_ylim(max(tr), min(tr))
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel("Crossline" if state.view_type == "inline" else "Inline")
        ax.set_ylabel("Time (ms)")
    if settings.show_title:
        ax.set_title(f"{state.view_type.title()} {state.section_number}")
    for txt in [
        ax.title,
        ax.xaxis.label,
        ax.yaxis.label,
        *ax.get_xticklabels(),
        *ax.get_yticklabels(),
    ]:
        txt.set_fontfamily(font_family(settings.font))
        txt.set_fontsize(settings.font_size)
    return SectionRenderResult(save_figure(fig, settings, rasters), (lo, hi))
