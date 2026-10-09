"""Content-fitted publication layout shared by section, map and profile exports.

Measure furniture at a fixed physical style, freeze layout, then resample raster
artists at the final DPI. SVG/PDF keep their vector artists and the same bounds.
"""
import io
import math

from matplotlib import rc_context
from matplotlib.backends.backend_agg import FigureCanvasAgg
from matplotlib.transforms import Bbox
from backend import resample


def figure_size(settings, ratio):
    if settings.canvas == "fixed":
        return settings.width / 25.4, settings.height / 25.4
    # The plot box's ratio is independent of the browser. Extra room here is
    # only for layout measurement; the final page is fitted to artist bounds.
    ratio = max(float(ratio), 0.01)
    return (8 * min(ratio, 1) + 1.5, 8 / max(ratio, 1) + 1.0)


def save_figure(fig, settings, rasters=(), colorbars=()):
    """rasters contains (image artist, native visible data), never previews."""
    if settings.canvas == "fixed":
        out = io.BytesIO()
        fig.savefig(out, format=settings.format, dpi=settings.dpi)
        return out.getvalue()
    canvas = FigureCanvasAgg(fig)
    fig.set_dpi(100)
    for ax in fig.axes:
        for spine in ax.spines.values():
            spine.set_linewidth(0.8)
        ax.tick_params(width=0.8)
    canvas.draw()
    # Disable constrained layout before changing DPI / output backend so
    # text metrics cannot change the crop or the plot's aspect ratio.
    fig.set_layout_engine("none")
    for colorbar, parent in colorbars:
        # Equal-aspect maps can shrink inside the layout slot. Match the
        # actual plot height, not that larger slot, to avoid tall colorbars
        # manufacturing blank strips above and below a wide map.
        plot_box = parent.get_position()
        bar_box = colorbar.ax.get_position()
        colorbar.ax.set_box_aspect(None)
        colorbar.ax.set_position([bar_box.x0, plot_box.y0, bar_box.width, plot_box.height])
    canvas.draw()
    bbox = fig.get_tightbbox(canvas.get_renderer()).padded(0.07)
    dpi = settings.long_edge / max(bbox.width, bbox.height)
    width = settings.long_edge if bbox.width >= bbox.height else max(1, math.ceil(bbox.width * dpi))
    height = settings.long_edge if bbox.height >= bbox.width else max(1, math.ceil(bbox.height * dpi))
    # Round the shorter edge outwards; this is padding, never image resizing.
    bbox = Bbox.from_bounds(bbox.x0, bbox.y0, width / dpi, height / dpi)
    for artist, native in rasters:
        box = artist.axes.get_window_extent().transformed(fig.dpi_scale_trans.inverted())
        w, h = max(1, math.ceil(box.width * dpi)), max(1, math.ceil(box.height * dpi))
        artist.set_data(resample.resample(native, w, h, settings.interpolation))
        artist.set_interpolation("none")
    transparent = settings.format == "png" and settings.background == "transparent"
    out = io.BytesIO()
    # Small epsilon avoids Agg truncating an exact integer due to floating
    # point arithmetic. Vector page dimensions retain the measured bounds.
    with rc_context({"svg.fonttype": "none", "pdf.fonttype": 42}):
        fig.savefig(out, format=settings.format, dpi=dpi + 1e-7,
                    bbox_inches=bbox, pad_inches=0,
                    transparent=transparent, facecolor="none" if transparent else "white")
    return out.getvalue()
