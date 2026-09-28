"""Publication 2D rendering: matplotlib figures assembled from survey sections."""

import io
import numpy as np
from matplotlib.figure import Figure
from backend import resample
from backend.style import get_cmap, font_family

#: A viewer-sized render grid, used when an export reuses the view resolution.
VIEW_TARGET = (1600, 1000)
#: Publication rasters may be upsampled far beyond the samples, but six real
#: samples must not turn into ten million invented ones.
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
    window = np.ascontiguousarray(z[t0 : t1 + 1, x0 : x1 + 1])
    native_height, native_width = window.shape
    if settings.resolution == "view":
        width, height = resample.fit_target(
            native_width,
            native_height,
            *VIEW_TARGET,
            budget=resample.INTERACTIVE_BUDGET,
        )
    else:
        width, height = settings.canvas_pixels()
        width, height = resample.fit_target(
            native_width,
            native_height,
            width,
            height,
            budget=resample.MAX_RENDER_PIXELS,
            max_upscale=EXPORT_MAX_UPSCALE,
        )
    raster = resample.resample(window, width, height, settings.interpolation)
    extent = (
        float(x[x0]) - 0.5,
        float(x[x1]) + 0.5,
        float(time[t0]) - 0.5,
        float(time[t1]) + 0.5,
    )
    return raster, extent, (native_width, native_height)


def amplitude(z, s):
    z = -z if s.reverse_polarity else z
    if s.clip_mode == "manual":
        if s.vmin is None or s.vmax is None or s.vmin >= s.vmax:
            raise ValueError("Manual amplitude minimum must be less than maximum.")
        lo, hi = s.vmin, s.vmax
    elif s.symmetric:
        hi = float(np.percentile(np.abs(z), s.clip_percentile)) or 1.0
        lo = -hi
    else:
        tail = (100 - s.clip_percentile) / 2
        lo, hi = np.percentile(z, [tail, 100 - tail]).tolist()
        if hi == lo:
            lo, hi = lo - 1, hi + 1
    return z, lo, hi


def render(survey, horizons, state, settings):
    x, t, z = survey.section(state.view_type, state.section_number)
    # Amplitude clipping always comes from the original section: the colour
    # range must not change with the interpolation mode or the zoom window.
    z, lo, hi = amplitude(z, state.seismic)
    raster, extent, source_shape = display_raster(x, t, z, state, settings)
    fig = Figure(
        figsize=(settings.width / 25.4, settings.height / 25.4),
        dpi=settings.dpi,
        layout="constrained",
    )
    ax = fig.subplots()
    if state.aspect_ratio_2d is not None:
        horizontal, vertical = state.aspect_ratio_2d
        ax.set_box_aspect(vertical / horizontal)
    cmap = get_cmap(state.seismic.colormap, state.seismic.reverse_colormap)
    canvas_width, canvas_height = settings.canvas_pixels()
    # The raster is normally already at the output resolution, so let Agg blit
    # it 1:1; only a coarser (view-resolution) raster is filtered on the way up.
    blend = (
        "nearest"
        if raster.size >= canvas_width * canvas_height
        else "bilinear"
    )
    ax.imshow(
        raster,
        cmap=cmap,
        vmin=lo,
        vmax=hi,
        extent=extent,
        # Row 0 is the smallest TWT; the time axis is inverted below, so the
        # array origin belongs at the bottom of the extent.
        origin="lower",
        aspect="auto",
        interpolation=blend,
        rasterized=True,
    )
    dash = {"solid": "-", "dashed": "--", "dotted": ":", "dashdot": "-."}
    markers = {
        "circle": "o",
        "square": "s",
        "triangle": "^",
        "diamond": "D",
        "cross": "x",
        "plus": "+",
    }
    for h in state.horizons:
        if not h.visible or h.id not in horizons:
            continue
        pts = np.asarray(horizons[h.id].section(state.view_type, state.section_number))
        if not len(pts):
            continue
        if h.line.visible and h.line.style != "none":
            if h.outline.enabled:
                ax.plot(
                    pts[:, 0],
                    pts[:, 1],
                    color="black",
                    lw=h.line.width + 2 * h.outline.width,
                    ls=dash[h.line.style],
                )
            ax.plot(
                pts[:, 0],
                pts[:, 1],
                color=h.color,
                lw=h.line.width,
                ls=dash[h.line.style],
            )
        if h.marker.visible and h.marker.shape != "none":
            ax.plot(
                pts[:, 0],
                pts[:, 1],
                ls="none",
                marker=markers[h.marker.shape],
                ms=h.marker.size,
                color=h.color,
                markeredgecolor="black" if h.outline.enabled else h.color,
                markeredgewidth=h.outline.width if h.outline.enabled else 0,
            )
    ax.set_xlim(state.x_range or [float(x[0]) - 0.5, float(x[-1]) + 0.5])
    tr = state.time_range or [float(t[0]), float(t[-1])]
    ax.set_ylim(max(tr), min(tr))
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel("Crossline" if state.view_type == "inline" else "Inline")
        ax.set_ylabel("TWT (ms)")
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
    out = io.BytesIO()
    fig.savefig(out, format=settings.format, dpi=settings.dpi)
    return out.getvalue()
