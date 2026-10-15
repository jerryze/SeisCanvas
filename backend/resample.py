"""Display resampling for seismic rendering.

This module is the rendering layer's only source of interpolated amplitudes.
Interpolation increases the sampling density of a picture, never the seismic
resolution of the data: hover, picking, amplitude clipping and every analysis
path must keep reading the original section, which is why nothing here is ever
written back to ``Survey`` or to disk.
"""

from __future__ import annotations

from functools import lru_cache
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


@lru_cache(maxsize=1)
def _sinc8_table():
    """513 phases of the SU least-squares finite sinc operator.

    This is a NumPy implementation of the mathematical construction described
    by Dave Hale's Seismic Unix ``mksinc`` and ``inttable8`` documentation:
    https://github.com/JohnWStockwellJr/SeisUnix/blob/master/src/cwp/lib/mksinc.c
    https://github.com/JohnWStockwellJr/SeisUnix/blob/master/src/cwp/lib/inttable8.c
    The normal equations minimise interpolation error up to the empirical
    bandwidth ``0.066 + 0.265 * log(8)`` (a fraction of Nyquist). The endpoint
    phases are cardinal, and intermediate positions use the nearest phase.
    No source code or coefficients are copied from SU.
    """
    bandwidth = min(0.066 + 0.265 * np.log(8.0), 1.0)
    taps = np.arange(8)
    autocorrelation = np.sinc(bandwidth * (taps[:, None] - taps[None, :]))
    phases = np.arange(1, 512, dtype=float) / 512.0
    crosscorrelation = np.sinc(bandwidth * (3.0 - taps[:, None] + phases))
    table = np.zeros((513, 8), dtype=float)
    table[1:-1] = np.linalg.solve(autocorrelation, crosscorrelation).T
    table[0, 3], table[-1, 4] = 1.0, 1.0
    table.flags.writeable = False
    return table


def sinc8(data, fractional_indices, axis=0):
    """Reconstruct original amplitudes with the finite eight-point SU kernel.

    ``fractional_indices`` is a one-dimensional sequence in source sample
    coordinates; the specified axis is replaced by that sequence. Eight taps
    cover ``floor(index)-3`` through ``floor(index)+4``. End samples extend
    constantly beyond the available data, and queries outside the source
    interval return the respective endpoint. Original integer knots are copied
    exactly, including NaNs. A missing sample with nonzero weight leaves a gap
    instead of manufacturing amplitudes across it. Overshoot is retained for
    the later display clipping stage. Neither the source nor its dtype is
    modified. Accumulation is chunked and never builds an output-by-eight cube.
    """
    source = np.asarray(data)
    if source.ndim == 0:
        raise ValueError("Sinc interpolation needs a sample axis.")
    axis = int(axis)
    if axis < 0:
        axis += source.ndim
    if not 0 <= axis < source.ndim:
        raise ValueError("Sinc sample axis is outside the source array.")
    indices = np.atleast_1d(np.asarray(fractional_indices, dtype=float))
    if indices.ndim != 1:
        raise ValueError("Sinc output indices must be one-dimensional.")
    dtype = np.result_type(source.dtype, np.float32)
    source = np.moveaxis(source.astype(dtype, copy=False), axis, 0)
    count, rest = source.shape[0], source.shape[1:]
    channels = int(np.prod(rest)) if rest else 1
    output = np.full((len(indices), channels), np.nan, dtype=dtype)
    if count == 0 or channels == 0 or not len(indices):
        return np.moveaxis(output.reshape((len(indices),) + rest), 0, axis)
    source = source.reshape(count, channels)
    valid = np.isfinite(indices)
    positions = np.clip(np.where(valid, indices, 0.0), 0.0, count - 1)
    base = np.floor(positions).astype(np.intp)
    phases = np.floor((positions - base) * 512.0 + 0.5).astype(np.intp)
    exact = positions == base
    table = _sinc8_table().astype(dtype, copy=False)
    # Bound a gathered tap to about one million amplitude elements.
    chunk = max(1, 1_000_000 // channels)
    for start in range(0, len(indices), chunk):
        stop = min(len(indices), start + chunk)
        block = np.zeros((stop - start, channels), dtype=dtype)
        weights = table[phases[start:stop]]
        for tap in range(8):
            locations = np.clip(base[start:stop] + tap - 3, 0, count - 1)
            weight = weights[:, tap, None]
            contribution = np.zeros_like(block)
            # 0 * NaN must not contaminate an unused neighbour at a knot.
            np.multiply(source[locations], weight, out=contribution, where=weight != 0)
            block += contribution
        knot = exact[start:stop]
        block[knot] = source[base[start:stop][knot]]
        block[~valid[start:stop]] = np.nan
        output[start:stop] = block
    return np.moveaxis(output.reshape((len(indices),) + rest), 0, axis)


def coordinate_edges(coordinates):
    """Outer cell bounds from actual endpoint sample spacing."""
    coordinates = np.asarray(coordinates, dtype=float)
    if coordinates.ndim != 1 or not coordinates.size:
        raise ValueError("Display coordinates need at least one sample.")
    if not np.isfinite(coordinates).all() or np.any(np.diff(coordinates) <= 0):
        raise ValueError("Display coordinates must be finite and increasing.")
    if len(coordinates) == 1:
        return float(coordinates[0]) - 0.5, float(coordinates[0]) + 0.5
    return (
        float(coordinates[0] - (coordinates[1] - coordinates[0]) / 2),
        float(coordinates[-1] + (coordinates[-1] - coordinates[-2]) / 2),
    )


def seismic_raster(x, time, values, width, height, extent=None, *, time_sinc=True):
    """World-aligned display amplitudes: time Sinc8, horizontal linear.

    Returns ``(raster, x_centres, time_centres, extent)``. Supply the complete
    original section plus the visible cell bounds to keep the sinc halo at
    viewport edges. Coordinates denote sample centres; output coordinates are
    uniform pixel centres in the requested world bounds. Trace coordinates may
    be irregular, but the original time samples must be uniform. No RGB image
    interpolation, pre-clipping, or additional smoothing is performed.
    """
    x, time = np.asarray(x, dtype=float), np.asarray(time, dtype=float)
    x_bounds, time_bounds = coordinate_edges(x), coordinate_edges(time)
    source = np.asarray(values)
    if source.shape != (len(time), len(x)):
        raise ValueError("Seismic amplitudes must match the time and trace coordinates.")
    if time_sinc and len(time) > 2 and not np.allclose(np.diff(time), time[1] - time[0], rtol=1e-5, atol=1e-9):
        raise ValueError("Time Sinc interpolation requires uniformly sampled amplitudes.")
    width, height = int(width), int(height)
    if width < 1 or height < 1:
        raise ValueError("Render grid must be at least 1 x 1.")
    if width > MAX_RENDER_DIMENSION or height > MAX_RENDER_DIMENSION:
        raise ValueError(f"Render dimensions exceed {MAX_RENDER_DIMENSION} pixels.")
    if width * height > MAX_RENDER_PIXELS:
        raise ValueError(f"Render grid exceeds {MAX_RENDER_PIXELS // 1_000_000} megapixels.")
    extent = tuple(x_bounds + time_bounds) if extent is None else tuple(map(float, extent))
    if len(extent) != 4 or not np.isfinite(extent).all():
        raise ValueError("Display extent needs four finite cell bounds.")
    left, right, top, bottom = extent
    if right <= left or bottom <= top:
        raise ValueError("Display extent bounds must be increasing.")
    gx = left + (np.arange(width) + 0.5) * (right - left) / width
    gt = top + (np.arange(height) + 0.5) * (bottom - top) / height
    xi = np.interp(gx, x, np.arange(len(x), dtype=float))
    ti = np.interp(gt, time, np.arange(len(time), dtype=float))
    base = np.floor(xi).astype(np.intp)
    neighbour = np.minimum(base + 1, len(x) - 1)
    fraction = xi - base
    dtype = np.result_type(source.dtype, np.float32)
    raster = np.empty((height, width), dtype=dtype)
    # Interpolate only traces actually contributing to requested pixels. Bound
    # both the copied source subset and time reconstruction for large sections.
    columns = max(1, min(width, 1_000_000 // (2 * max(len(time), height))))
    for start in range(0, width, columns):
        stop = min(width, start + columns)
        used = np.unique(np.concatenate((base[start:stop], neighbour[start:stop])))
        if time_sinc:
            temporal = sinc8(source[:, used], ti, axis=0)
        else:
            # A fixed-TWT 3D slice has two spatial axes: linear in both.
            rows = np.floor(ti).astype(np.intp)
            neighbours = np.minimum(rows + 1, len(time) - 1)
            weights = (ti - rows)[:, None]
            lower, upper = source[np.ix_(rows, used)], source[np.ix_(neighbours, used)]
            temporal = np.zeros(lower.shape, dtype=dtype)
            contribution = np.zeros_like(temporal)
            np.multiply(lower, 1 - weights, out=temporal, where=weights != 1)
            np.multiply(upper, weights, out=contribution, where=weights != 0)
            temporal += contribution
        lo = temporal[:, np.searchsorted(used, base[start:stop])]
        hi = temporal[:, np.searchsorted(used, neighbour[start:stop])]
        weight = fraction[None, start:stop]
        a, b = np.zeros_like(lo), np.zeros_like(hi)
        np.multiply(lo, 1 - weight, out=a, where=weight != 1)
        np.multiply(hi, weight, out=b, where=weight != 0)
        raster[:, start:stop] = a + b
    return raster, gx, gt, extent


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
