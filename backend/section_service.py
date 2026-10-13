"""Interactive 2D section reads: window -> resample -> serialize for the viewer.

The publication path lives in ``backend.rendering.render``; this module serves
the browsing pipeline behind ``/api/section``.  Amplitude clipping, hover and
picking always use the original section; only the raster below is a rendering
artefact.
"""

import numpy as np

from backend import resample
from backend.rendering import amplitude, window_indices
from backend.trace_overlay import aligned_raster, build_trace_overlay, coordinate_edges, overlays_enabled


def interactive_section(survey, horizons, req) -> dict:
    """Serialize the visible window of one section for the 2D viewer."""
    x, t, z = survey.section(req.view_type, req.section_number)
    trace_amplitudes, lo, hi = amplitude(z, req.seismic)
    trace_display = overlays_enabled(req.seismic)
    x0, x1 = window_indices(x, req.x_range)
    t0, t1 = window_indices(t, req.time_range)
    window = np.ascontiguousarray(z[t0 : t1 + 1, x0 : x1 + 1])
    native_height, native_width = window.shape
    budget = resample.QUALITY_BUDGETS[req.quality]
    method = resample.method(
        req.interpolation
        if req.interpolation is not None
        else req.seismic.interpolation,
        resample.QUALITY_INTERPOLATION[req.quality],
    )
    adaptive = req.seismic.adaptive_resolution or req.quality != "interactive"
    if adaptive:
        width, height = resample.fit_target(
            native_width,
            native_height,
            req.target_width,
            req.target_height,
            budget=budget,
        )
    else:
        width, height = resample.fit_target(
            native_width, native_height, budget=budget, max_upscale=1.0
        )
    key = (
        "render", req.view_type, req.section_number, x0, x1, t0, t1,
        width, height, method, req.seismic.reverse_polarity, trace_display,
    )
    raster = survey.render_cache.get(key)
    if trace_display:
        if raster is None:
            raster, display_x, display_time, extent = aligned_raster(
                x[x0:x1 + 1], t[t0:t1 + 1], window, width, height, method
            )
            survey.render_cache[key] = raster
        else:
            survey.render_cache.move_to_end(key)
            # The coordinates are inexpensive and independent of amplitudes.
            left, right = coordinate_edges(x[x0:x1 + 1])
            top, bottom = coordinate_edges(t[t0:t1 + 1])
            extent = (left, right, top, bottom)
            display_x = left + (np.arange(width) + 0.5) * (right - left) / width
            display_time = top + (np.arange(height) + 0.5) * (bottom - top) / height
    elif raster is None:
        raster = resample.resample(window, width, height, method)
        survey.render_cache[key] = raster
    else:
        survey.render_cache.move_to_end(key)
    result = {
        "x": (display_x if trace_display else np.linspace(float(x[x0]), float(x[x1]), width)).tolist(),
        "time": (display_time if trace_display else np.linspace(float(t[t0]), float(t[t1]), height)).tolist(),
        # Display pixels only; hover, picking and clipping read the
        # original amplitudes (see /api/sample).
        "z": resample.display_values(
            raster,
            min(lo, hi),
            max(lo, hi),
            method,
            resampled=(width, height) != (native_width, native_height),
        ),
        "vmin": lo,
        "vmax": hi,
        "native_shape": [len(t), len(x)],
        "render_shape": [native_height, native_width],
        "preview_shape": [height, width],
        "interpolation": method,
        "adaptive": adaptive,
        "quality": req.quality,
        "window": {
            "x_range": [float(x[x0]), float(x[x1])],
            "time_range": [float(t[t0]), float(t[t1])],
        },
        "horizons": {
            key: h.section(req.view_type, req.section_number)
            for key, h in horizons.items()
        },
    }
    if trace_display:
        result["raster_extent"] = list(extent)
        result["trace_overlay"] = build_trace_overlay(x, t, trace_amplitudes, req, lo, hi)
    return result
