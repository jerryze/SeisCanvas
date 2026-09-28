"""Display resampling for seismic rendering.

This module is the rendering layer's only source of interpolated amplitudes.
Interpolation increases the sampling density of a picture, never the seismic
resolution of the data: hover, picking, amplitude clipping and every analysis
path must keep reading the original section, which is why nothing here is ever
written back to ``Survey`` or to disk.
"""

from __future__ import annotations

from typing import Literal

import numpy as np
from PIL import Image

Interpolation = Literal["nearest", "bilinear", "bicubic"]

METHODS = ("nearest", "bilinear", "bicubic")
FILTERS = {
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
}

#: Rendering guards, so an extreme DPI or viewport cannot exhaust memory.
MAX_RENDER_PIXELS = 40_000_000
MAX_RENDER_DIMENSION = 8000
#: Interactive responses stay small enough to stay responsive while zooming.
INTERACTIVE_BUDGET = 600_000
PREVIEW_BUDGET = 150_000
#: Never invent more display samples than this multiple of the real ones.
MAX_UPSCALE = 3.0
#: The colour ramp has 256 entries; a 12 bit display grid is already lossless
#: on screen and keeps the browser payload small.
DISPLAY_STEPS = 4095

QUALITY_BUDGETS = {
    "preview": PREVIEW_BUDGET,
    "interactive": INTERACTIVE_BUDGET,
    "publication": MAX_RENDER_PIXELS,
}
QUALITY_INTERPOLATION = {
    "preview": "bilinear",
    "interactive": "bilinear",
    "publication": "bicubic",
}


def method(value: str | None, default: Interpolation = "bilinear") -> Interpolation:
    """Normalise an interpolation name, falling back to a safe default."""
    name = str(value or "").strip().lower()
    return name if name in METHODS else default  # type: ignore[return-value]


def fit_target(
    native_width: int,
    native_height: int,
    target_width: int | None = None,
    target_height: int | None = None,
    *,
    budget: int = INTERACTIVE_BUDGET,
    max_dimension: int = MAX_RENDER_DIMENSION,
    max_upscale: float = MAX_UPSCALE,
) -> tuple[int, int]:
    """Render grid for a native window, matched to the requested pixels.

    ``target_width``/``target_height`` are the pixels the raster will occupy on
    screen (or in the exported figure).  The result never exceeds the pixel
    request, never over-samples the real data by more than ``max_upscale`` and
    never exceeds the interactive node budget.
    """
    width = int(target_width) if target_width else int(native_width)
    height = int(target_height) if target_height else int(native_height)
    width = max(1, min(width, max(1, int(np.ceil(native_width * max_upscale)))))
    height = max(1, min(height, max(1, int(np.ceil(native_height * max_upscale)))))
    if width > max_dimension or height > max_dimension:
        scale = max_dimension / max(width, height)
        width, height = max(1, int(width * scale)), max(1, int(height * scale))
    if width * height > budget:
        scale = (budget / (width * height)) ** 0.5
        width, height = max(1, int(width * scale)), max(1, int(height * scale))
    return width, height


def display_decimals(vmin: float, vmax: float, steps: int = DISPLAY_STEPS) -> int:
    """Decimal places that still resolve one display step of the colour range."""
    span = abs(float(vmax) - float(vmin))
    if not np.isfinite(span) or span <= 0:
        return 3
    step = span / steps
    return int(max(0, min(6, np.ceil(-np.log10(step)))))


def quantize(values, vmin: float, vmax: float, steps: int = DISPLAY_STEPS):
    """Snap display amplitudes to a fine grid: invisible on screen, cheap to send."""
    span = float(vmax) - float(vmin)
    if not np.isfinite(span) or span <= 0:
        return np.asarray(values, dtype=np.float32)
    step = span / steps
    decimals = display_decimals(vmin, vmax, steps)
    quantized = np.round((np.asarray(values, dtype=np.float32) - float(vmin)) / step)
    quantized = quantized * step + float(vmin)
    return np.round(quantized, decimals).astype(np.float32)


def display_values(
    values,
    vmin: float,
    vmax: float,
    interpolation: str = "bilinear",
    *,
    resampled: bool = True,
):
    """JSON-ready display amplitudes.

    Real samples are never altered: an unresampled window and nearest mode are
    sent exactly.  An interpolated raster is quantized and rounded in double
    precision, which keeps the payload compact without visible banding.
    """
    array = np.asarray(values, dtype=np.float32)
    if not resampled or method(interpolation) == "nearest":
        return array.tolist()
    decimals = display_decimals(vmin, vmax)
    snapped = quantize(array, vmin, vmax).astype(np.float64)
    return np.round(snapped, decimals).tolist()


def resample(
    data,
    width: int,
    height: int,
    interpolation: str = "bilinear",
    *,
    clip: bool = True,
):
    """Resample a 2D amplitude window to ``width`` x ``height`` display samples.

    Upsampling interpolates; downsampling uses the same filters, whose support
    is scaled by the reduction factor in Pillow, so it averages instead of
    dropping samples (no aliasing).
    """
    values = np.asarray(data, dtype=np.float32)
    if values.ndim != 2:
        raise ValueError("Display resampling needs a 2D amplitude window.")
    rows, columns = values.shape
    width, height = int(width), int(height)
    if width < 1 or height < 1:
        raise ValueError("Render grid must be at least 1 x 1.")
    if width * height > MAX_RENDER_PIXELS:
        raise ValueError(
            f"Render grid exceeds {MAX_RENDER_PIXELS // 1_000_000} megapixels."
        )
    name = method(interpolation)
    if (width, height) == (columns, rows):
        result = values.astype(np.float32, copy=True)
    elif name == "nearest":
        columns_index = np.rint(np.linspace(0, columns - 1, width)).astype(np.intp)
        rows_index = np.rint(np.linspace(0, rows - 1, height)).astype(np.intp)
        result = values[np.ix_(rows_index, columns_index)].astype(np.float32, copy=True)
    else:
        image = Image.fromarray(np.ascontiguousarray(values), mode="F")
        result = np.array(
            image.resize((width, height), FILTERS[name]), dtype=np.float32
        )
    if clip and np.isfinite(values).any():
        # Cubic kernels overshoot; the display raster must not show amplitudes
        # that do not exist anywhere in the window it was built from.
        low, high = float(np.nanmin(values)), float(np.nanmax(values))
        np.clip(result, low, high, out=result)
    return result
