"""Interactive 2D seismic reconstruction from one cached native section."""

import numpy as np

from backend import resample
from backend.horizon_display import sg_section, json_points
from backend.rendering import amplitude, window_indices
from backend.trace_overlay import build_trace_overlay, coordinate_cell_edges, overlays_enabled, reconstruction_extent


def _json_values(values):
    """Preserve native/reconstructed amplitudes exactly; gaps stay empty cells."""
    if np.isfinite(values).all():
        return values.tolist()
    return np.where(np.isfinite(values), values, None).tolist()


def section_raster(survey, x, t, z, state, target_width=None, target_height=None,
                   quality="interactive", cache_id=None, budget=None, time_sinc=True):
    """Shared native-cell or Sinc8/linear amplitude display, before clipping.

    2D, vertical 3D slices and A–B profiles use the same source-cell coordinates,
    viewport fitting and bounded cache. Fixed-TWT planes set time_sinc=False
    because both of their axes are spatial. Cached values never include color,
    clipping or polarity, and no display grid is fed back into this function.
    """
    x0, x1 = window_indices(x, state.x_range)
    t0, t1 = window_indices(t, state.time_range)
    window = z[t0:t1 + 1, x0:x1 + 1]
    native_height, native_width = window.shape
    x_edges = coordinate_cell_edges(x)[x0:x1 + 2]
    time_edges = coordinate_cell_edges(t)[t0:t1 + 2]
    extent = (float(x_edges[0]), float(x_edges[-1]), float(time_edges[0]), float(time_edges[-1]))
    interpolate = state.seismic.background_interpolation
    if interpolate:
        extent = reconstruction_extent(x, t, state.x_range, state.time_range)
        target_width, target_height = target_width or native_width, target_height or native_height
        width, height = resample.fit_target(
            native_width, native_height, target_width, target_height,
            budget=budget or resample.QUALITY_BUDGETS[quality],
            max_upscale=max(target_width / native_width, target_height / native_height, 1.0),
        )
        key = (
            "section-display", cache_id, x0, x1, t0, t1, time_sinc,
            state.x_range, state.time_range,
            width, height, state.seismic.background_interpolation,
            quality,
        )
        raster = survey.render_cache.get(key)
        if raster is None:
            # Full source coordinates/data provide the four-sample support on
            # both sides of this window. Neither zoom nor pan truncates taps.
            raster, display_x, display_time, _ = resample.seismic_raster(
                x, t, z, width, height, extent, **({} if time_sinc else {"time_sinc": False}),
            )
            survey.render_cache[key] = raster
        else:
            survey.render_cache.move_to_end(key)
            display_x = extent[0] + (np.arange(width) + 0.5) * (extent[1] - extent[0]) / width
            display_time = extent[2] + (np.arange(height) + 0.5) * (extent[3] - extent[2]) / height
        x_edges = np.linspace(extent[0], extent[1], width + 1)
        time_edges = np.linspace(extent[2], extent[3], height + 1)
    else:
        # Disabled means exact native cells: viewport requests and export
        # interpolation selectors cannot silently interpolate or decimate.
        raster, width, height = window, native_width, native_height
        display_x, display_time = x[x0:x1 + 1], t[t0:t1 + 1]
    return {
        "values": raster, "x": display_x, "time": display_time,
        "x_edges": x_edges, "time_edges": time_edges, "extent": extent,
        "native_shape": [len(t), len(x)],
        "render_shape": [native_height, native_width], "preview_shape": [height, width],
        "window": {"x_range": [float(x[x0]), float(x[x1])],
                   "time_range": [float(t[t0]), float(t[t1])]},
        "interpolation": ("sinc8" if time_sinc else "linear") if interpolate else "native",
    }


def interactive_section(survey, horizons, req) -> dict:
    """Serialize native blocks or a Sinc8-time/linear-trace amplitude raster."""
    x, t, z = survey.section(req.view_type, req.section_number)
    trace_amplitudes, lo, hi = amplitude(z, req.seismic)
    display = section_raster(survey, x, t, z, req, req.target_width, req.target_height,
                             req.quality, (req.view_type, req.section_number))
    result = {
        "x": display["x"].tolist(), "time": display["time"].tolist(),
        "x_edges": display["x_edges"].tolist(), "time_edges": display["time_edges"].tolist(),
        "raster_extent": list(display["extent"]), "z": _json_values(display["values"]),
        "vmin": lo, "vmax": hi,
        **{key: display[key] for key in ("native_shape", "render_shape", "preview_shape", "interpolation", "window")},
        "background_interpolation": req.seismic.background_interpolation,
        "wiggle_interpolation": req.seismic.wiggle_interpolation,
        "adaptive": req.seismic.background_interpolation, "quality": req.quality,
        "horizons": {key: h.section(req.view_type, req.section_number) for key, h in horizons.items()},
    }
    if req.horizon_sg:
        result["horizon_display"] = {
            "algorithm": "sg", "window": req.horizon_sg_window,
            "view_type": req.view_type, "section_number": req.section_number,
            "points": {key: json_points(sg_section(h, req.view_type, req.section_number,
                        req.horizon_sg_window, x, result["horizons"][key]))
                       for key, h in horizons.items()},
        }
    if overlays_enabled(req.seismic):
        result["trace_overlay"] = build_trace_overlay(x, t, trace_amplitudes, req, lo, hi)
    return result
