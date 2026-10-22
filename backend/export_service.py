"""Render an export request and register it as an immutable queue item.

``Add to Export`` reads the current viewer state, renders the final figure at the
publication settings and stores the bytes in the active export session.  The item
is detached from the viewer from that moment on.

The queue request schemas (``Queue2DRequest``/``QueueMapRequest``/
``Queue3DRequest``/``QueueAddRequest``/``RenameRequest``) live in
``backend.models``.
"""

from __future__ import annotations

from time import perf_counter
import logging

from backend import naming
from backend.export3d import decode_scene_png, encode_scene
from backend.export_queue import session
from backend.horizon_map import difference_horizons, render_map, render_profile
from backend.models import (
    Queue2DRequest,
    Queue3DRequest,
    QueueMapRequest,
    QueueProfileRequest,
    SceneExportRequest,
    Seismic,
)
from backend.rendering import render_with_metadata


def dataset_label(survey, requested=None) -> str:
    """Project/dataset name, falling back to the SEG-Y file name (requirement 7)."""
    if requested and requested.strip():
        return naming.dataset_label(requested)
    if survey is not None:
        return naming.dataset_label(survey.path.stem, "Dataset")
    return "Dataset"


def _visible_horizons(state, horizons):
    return [h for h in state.horizons if h.visible and h.id in horizons]


def add_2d(survey, horizons, req: Queue2DRequest) -> dict:
    state, settings = req.state, req.settings
    dataset = dataset_label(survey, req.dataset)
    inline = state.view_type == "inline"
    visible = _visible_horizons(state, horizons)
    names = [horizons[h.id].name for h in visible]
    content = naming.horizons_label(names) or "SeismicOnly"
    colormap = naming.colormap_label(state.seismic.colormap, "Seismic")
    builder = naming.inline_name if inline else naming.crossline_name
    view_type = "2d_inline" if inline else "2d_crossline"
    filename = builder(
        dataset,
        state.section_number,
        content,
        colormap,
        settings.width,
        settings.height,
        settings.dpi,
        settings.format,
    )
    rendered = render_with_metadata(survey, horizons, state, settings)
    location = {"inline" if inline else "crossline": state.section_number}
    summary = {
        **location,
        "horizons": [h.name for h in visible],
        "horizon_styles": [h.model_dump() for h in state.horizons],
        "horizon_sg": state.horizon_sg,
        "horizon_sg_window": state.horizon_sg_window,
        "seismic_colormap": state.seismic.colormap,
        "reverse_colormap": state.seismic.reverse_colormap,
        "clip_mode": state.seismic.clip_mode,
        "clip_percentile": state.seismic.clip_percentile,
        "symmetric": state.seismic.symmetric,
        "vmin": state.seismic.vmin,
        "vmax": state.seismic.vmax,
        "colorbar_range": list(rendered.colorbar_range),
        "reverse_polarity": state.seismic.reverse_polarity,
        "wiggle": state.seismic.wiggle,
        "variable_area": state.seismic.variable_area,
        "wiggle_gain": state.seismic.wiggle_gain,
        "variable_area_color": state.seismic.variable_area_color,
        "background_interpolation": state.seismic.background_interpolation,
        "wiggle_interpolation": state.seismic.wiggle_interpolation,
        "background_algorithm": "sinc8_time_linear_trace" if state.seismic.background_interpolation else "native",
        "trace_viewport_width": state.trace_viewport_width,
        "trace_viewport_height": state.trace_viewport_height,
        "x_range": list(state.x_range) if state.x_range else None,
        "time_range": list(state.time_range) if state.time_range else None,
        "aspect_ratio_2d": list(state.aspect_ratio_2d) if state.aspect_ratio_2d else None,
    }
    return session().add(
        data=rendered.data,
        filename=filename,
        view_type=view_type,
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
    )


def add_map(survey, horizons, req: QueueMapRequest) -> dict:
    state, settings = req.state, req.settings
    if state.horizon not in horizons:
        raise ValueError("Horizon not found.")
    horizon = horizons[state.horizon]
    dataset = dataset_label(survey, req.dataset)
    # Difference filenames identify the pair; the manifest keeps the scalar.
    scalar = {"twt": "Time", "amplitude": "Amplitude", "difference": "Diff"}[state.color_by]
    content = scalar
    difference = None
    if state.color_by == "difference":
        reference, comparison = difference_horizons(state, horizons)
        content = naming.comparison_label(comparison.name, reference.name)
        difference = {
            "reference": state.difference_reference,
            "reference_name": reference.name,
            "comparison": state.difference_comparison,
            "comparison_name": comparison.name,
            "type": state.difference_type,
            "operation": "comparison - reference",
        }
    display = naming.display_label(state.display)
    colormap = naming.colormap_label(state.colormap, "Petrel")
    filename = naming.horizon_map_name(
        dataset,
        horizon.name,
        content,
        display,
        colormap,
        settings.width,
        settings.height,
        settings.dpi,
        settings.format,
        difference_type=state.difference_type if difference is not None else None,
    )
    data = render_map(survey, horizon, state, settings, horizons, req.profile)
    profile = req.profile.model_dump(mode="json") if req.profile is not None else None
    summary = {
        "horizon": horizon.name,
        "profile": profile,
        "color_by": state.color_by,
        "clip_percentile": state.clip_percentile,
        "scalar": scalar,
        "difference": difference,
        "display": state.display,
        "colormap": state.colormap,
        "reverse_colormap": state.reverse_colormap,
        "range_mode": state.range_mode,
        "vmin": state.vmin,
        "vmax": state.vmax,
        "contours": state.contours,
        "contour_interval": state.interval,
        "contour_interval_auto": state.interval is None,
        "contour_line_width": state.line_width,
        "contour_labels": state.labels,
        "colorbar": state.colorbar,
        "x_range": list(state.x_range) if state.x_range else None,
        "y_range": list(state.y_range) if state.y_range else None,
    }
    return session().add(
        data=data,
        filename=filename,
        view_type="horizon_map",
        dataset=dataset,
        view_state={**state.model_dump(), "profile": profile},
        summary=summary,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
    )


def add_profile(survey, horizons, req: QueueProfileRequest) -> dict:
    """Render the standalone A–B profile figure and queue it."""
    state = req.state
    if state.horizon not in horizons:
        raise ValueError("Horizon not found.")
    horizon = horizons[state.horizon]
    dataset = dataset_label(survey, req.dataset)
    data, info = render_profile(
        survey,
        state,
        horizons,
        req.a,
        req.b,
        req.settings,
        req.curve_colors,
        req.colormap,
        req.reverse_colormap,
        req.show_curves,
        req.show_legend,
        req.show_ab,
        req.section_state(seismic=Seismic(colormap=req.colormap, reverse_colormap=req.reverse_colormap)),
        req.horizons,
    )
    filename = naming.map_profile_name(
        dataset,
        horizon.name,
        "Seismic",
        naming.colormap_label(req.seismic.colormap if req.seismic else req.colormap, "Seismic"),
        req.settings.width,
        req.settings.height,
        req.settings.dpi,
        req.settings.format,
    )
    summary = {
        "horizon": horizon.name,
        "figure": "ab_profile",
        "a": info["a"],
        "b": info["b"],
        "a_distance": info["a_distance"],
        "b_distance": info["b_distance"],
        "path_start": info["path_start"],
        "path_end": info["path_end"],
        "colormap": (req.seismic.colormap if req.seismic else req.colormap),
        "reverse_colormap": (req.seismic.reverse_colormap if req.seismic else req.reverse_colormap),
        "overlays": info["curves"] if req.show_curves else [],
        "show_curves": req.show_curves,
        "show_legend": req.show_legend,
        "show_ab": req.show_ab,
        "amplitude_range": [info["vmin"], info["vmax"]],
        "seismic": req.section_state(seismic=Seismic(colormap=req.colormap, reverse_colormap=req.reverse_colormap)).seismic.model_dump(),
        "aspect_ratio_2d": req.aspect_ratio_2d,
        "horizons": [h.model_dump() for h in req.horizons] if req.horizons is not None else None,
        "x_range": req.x_range, "time_range": req.time_range,
    }
    return session().add(
        data=data,
        filename=filename,
        view_type="horizon_map",
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        render=req.settings.model_dump(),
        width_mm=req.settings.width,
        height_mm=req.settings.height,
        dpi=req.settings.dpi,
    )


def add_3d(survey, req: Queue3DRequest) -> dict:
    started = perf_counter()
    state, settings = req.state, req.settings
    dataset = dataset_label(survey, req.dataset)
    slice_positions = {
        kind: [s.position for s in getattr(state.slices, kind) if s.visible]
        for kind in ("inline", "crossline", "time")
    }
    surfaces = [
        h for h in state.horizons if h.visible and h.display_mode == "full_surface"
    ]
    names = [h.name for h in state.horizons if h.visible]
    content = naming.horizons_label(names)
    has_slices = any(slice_positions.values())
    if has_slices:
        view_type = "3d_multislice"
        label = naming.slice_label(
            slice_positions["inline"],
            slice_positions["crossline"],
            slice_positions["time"],
        )
        filename = naming.multislice_name(
            dataset, label, content, settings.width, settings.height, settings.dpi, req.format
        )
    else:
        view_type = "3d_horizon_surface"
        amplitude_surfaces = [h for h in surfaces if h.color_by == "amplitude"]
        if amplitude_surfaces:
            scalar = "Amplitude" if len(amplitude_surfaces) == len(surfaces) else "Mixed"
            colormap = state.seismic.colormap if scalar == "Amplitude" else "Mixed"
        else:
            scalar = "Time"
            colormap = surfaces[0].horizon_colormap if surfaces else "petrel"
        filename = naming.horizon_surface_name(
            dataset,
            naming.horizons_label([h.name for h in surfaces]) or content or "Horizons",
            scalar,
            naming.colormap_label(colormap, "Petrel"),
            settings.width,
            settings.height,
            settings.dpi,
            req.format,
        )
    request = SceneExportRequest(
        dpi=(req.render_dpi or 300) if settings.canvas == "fit" else None,
        png=req.png,
        format=req.format,
        width=req.width_px,
        height=req.height_px,
        scale=req.scale,
        background=settings.background,
        vector_overlay=req.vector_overlay,
    )
    phase = perf_counter()
    raw, pixels, size = decode_scene_png(request)
    timings = {**req.timings, "server_image_validation": (perf_counter() - phase) * 1000}
    phase = perf_counter()
    data = encode_scene(request, raw, pixels, size)
    timings["pdf_svg_generation" if req.format != "png" else "png_metadata"] = (perf_counter() - phase) * 1000
    timings["server_packaging"] = (perf_counter() - started) * 1000
    timings["total"] = req.timings.get("total", 0) + timings["server_packaging"]
    logging.getLogger(__name__).info("3D export timings (ms): %s", timings)
    summary = {
        "export_timings_ms": timings,
        "vector_axes": req.vector_overlay is not None,
        "axis_text_representation": "glyph_outlines" if req.vector_overlay is not None else "raster",
        "slices": slice_positions,
        "interpolation": "sinc8-time-linear-space" if state.seismic.background_interpolation else "native",
        "horizons": [h.model_dump() for h in state.horizons],
        "horizon_names": [h.name for h in state.horizons],
        "surface_horizons": [h.name for h in surfaces],
        "horizon_amplitude_colormap": state.seismic.colormap if any(h.color_by == "amplitude" for h in surfaces) else None,
        "camera": state.scene.camera,
        "lighting": any(h.lighting for h in state.horizons),
        "opacity": {h.name: h.opacity for h in state.horizons},
        "vertical_exaggeration": state.scene.aspect_ratio[2],
        "aspect_ratio": list(state.scene.aspect_ratio),
        "quality": state.scene.quality,
        "background": settings.background,
        "scene_background": state.scene.background,
        "seismic": state.seismic.model_dump(),
    }
    return session().add(
        data=data,
        filename=filename,
        view_type=view_type,
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
        pixel_size=size,
        scale=req.scale,
    )
