"""Interactive 2D section reads: window -> resample -> serialize for the viewer.

The publication path lives in ``backend.rendering.render``; this module serves
the browsing pipeline behind ``/api/section``.  Amplitude clipping, hover and
picking always use the original section; only the raster below is a rendering
artefact.
"""

import numpy as np

from backend import resample
from backend.rendering import amplitude, window_indices


def interactive_section(survey, horizons, req) -> dict:
    """Serialize the visible window of one section for the 2D viewer."""
    x, t, z = survey.section(req.view_type, req.section_number)
    _, lo, hi = amplitude(z, req.seismic)
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
        width, height, method, req.seismic.reverse_polarity,
    )
    raster = survey.render_cache.get(key)
    if raster is None:
        raster = resample.resample(window, width, height, method)
        survey.render_cache[key] = raster
    else:
        survey.render_cache.move_to_end(key)
    return {
        "x": np.linspace(float(x[x0]), float(x[x1]), width).tolist(),
        "time": np.linspace(float(t[t0]), float(t[t1]), height).tolist(),
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
