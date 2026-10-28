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
    if survey is not None and getattr(survey, "path", None) is not None:
        return naming.dataset_label(survey.path.stem, "Dataset")
    return "层位数据"


def resolved_export_name(req, filename):
    fmt = req.format if req.kind == "3d" else req.settings.format
    if req.filename is not None:
        return naming.requested_filename(req.filename, fmt)
    return filename


def export_name(survey, horizons, req):
    if req.kind == "map":
        return map_export_name(survey, horizons, req)[0]
    if req.kind == "2d":
        filename = section_export_name(survey, horizons, req)[0]
    elif req.kind == "3d":
        filename = scene_export_name(survey, req)[0]
    else:
        filename = profile_export_name(survey, horizons, req)
    return resolved_export_name(req, filename)


def _visible_horizons(state, horizons):
    return [h for h in state.horizons if h.visible and h.id in horizons]


def section_export_name(survey, horizons, req: Queue2DRequest):
    state, settings = req.state, req.settings
    dataset = dataset_label(survey, req.dataset)
    inline = state.view_type == "inline"
    visible = _visible_horizons(state, horizons)
    view_type = "2d_inline" if inline else "2d_crossline"
    filename = naming.figure_name("2D", f"{'IL' if inline else 'XL'}{naming.number(state.section_number)}", ext=settings.format)
    return filename, dataset, view_type, visible


def add_2d(survey, horizons, req: Queue2DRequest, restore=None, sink=None) -> dict:
    state, settings = req.state, req.settings
    filename, dataset, view_type, visible = section_export_name(survey, horizons, req)
    filename = resolved_export_name(req, filename)
    inline = state.view_type == "inline"
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
        "colorbar_range": list(rendered.colorbar_range) if rendered.colorbar_range is not None else None,
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
    return (sink if sink is not None else session()).add(
        data=rendered.data,
        filename=filename,
        preserve_filename=True,
        view_type=view_type,
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        restore=restore,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
    )


def map_export_name(survey, horizons, req: QueueMapRequest):
    """Resolve map naming without reading rasters or rendering a figure."""
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
    if difference is not None:
        figure_type = "差值图" if state.difference_type == "signed" else "误差图"
        filename = naming.figure_name(figure_type, content, ext=settings.format)
    else:
        filename = naming.figure_name("层位图", horizon.name, ext=settings.format)
    filename = resolved_export_name(req, filename)
    return filename, dataset, scalar, difference


def add_map(survey, horizons, req: QueueMapRequest, restore=None, sink=None) -> dict:
    state, settings = req.state, req.settings
    filename, dataset, scalar, difference = map_export_name(survey, horizons, req)
    horizon = horizons[state.horizon]
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
    return (sink if sink is not None else session()).add(
        data=data,
        filename=filename,
        preserve_filename=True,
        view_type="horizon_map",
        dataset=dataset,
        view_state={**state.model_dump(), "profile": profile},
        summary=summary,
        restore=restore,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
    )


def profile_export_name(survey, horizons, req: QueueProfileRequest):
    if req.state.horizon not in horizons:
        raise ValueError("Horizon not found.")
    return naming.figure_name("AB剖面", naming.profile_location(req.a, req.b), ext=req.settings.format)


def add_profile(survey, horizons, req: QueueProfileRequest, restore=None, sink=None) -> dict:
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
    filename = resolved_export_name(req, profile_export_name(survey, horizons, req))
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
        "amplitude_range": [info["vmin"], info["vmax"]] if info["vmin"] is not None else None,
        "seismic": req.section_state(seismic=Seismic(colormap=req.colormap, reverse_colormap=req.reverse_colormap)).seismic.model_dump(),
        "aspect_ratio_2d": req.aspect_ratio_2d,
        "horizons": [h.model_dump() for h in req.horizons] if req.horizons is not None else None,
        "x_range": req.x_range, "time_range": req.time_range,
    }
    return (sink if sink is not None else session()).add(
        data=data,
        filename=filename,
        preserve_filename=True,
        view_type="horizon_map",
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        restore=restore,
        render=req.settings.model_dump(),
        width_mm=req.settings.width,
        height_mm=req.settings.height,
        dpi=req.settings.dpi,
    )


def scene_export_name(survey, req):
    state, settings = req.state, req.settings
    dataset = dataset_label(survey, req.dataset)
    slice_positions = {
        kind: [s.position for s in getattr(state.slices, kind) if s.visible]
        for kind in ("inline", "crossline", "time")
    }
    surfaces = [
        h for h in state.horizons if h.visible and h.display_mode == "full_surface"
    ]
    if any(slice_positions.values()):
        view_type = "3d_multislice"
        # Compact numeric positions without redundant zero padding.
        filename = naming.figure_name("3D", naming.compact_slices(slice_positions), ext=req.format)
    else:
        view_type = "3d_horizon_surface"
        names = list(dict.fromkeys(h.name for h in surfaces))
        content = "-".join(names) if len(names) <= 3 else f"{len(names)}个层位"
        filename = naming.figure_name("3D层位", content or "未选择层位", ext=req.format)
    return filename, dataset, view_type, slice_positions, surfaces


def add_3d(survey, req: Queue3DRequest, restore=None, sink=None) -> dict:
    started = perf_counter()
    state, settings = req.state, req.settings
    filename, dataset, view_type, slice_positions, surfaces = scene_export_name(survey, req)
    filename = resolved_export_name(req, filename)
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
    return (sink if sink is not None else session()).add(
        data=data,
        filename=filename,
        preserve_filename=True,
        view_type=view_type,
        dataset=dataset,
        view_state=state.model_dump(),
        summary=summary,
        restore=restore,
        render=settings.model_dump(),
        width_mm=settings.width,
        height_mm=settings.height,
        dpi=settings.dpi,
        pixel_size=size,
        scale=req.scale,
    )
