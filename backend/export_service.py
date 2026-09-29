"""Render an export request and register it as an immutable queue item.

``Add to Export`` reads the current viewer state, renders the final figure at the
publication settings and stores the bytes in the active export session.  The item
is detached from the viewer from that moment on.

The queue request schemas (``Queue2DRequest``/``QueueMapRequest``/
``Queue3DRequest``/``QueueAddRequest``/``RenameRequest``) live in
``backend.models``.
"""

from __future__ import annotations

from backend import naming
from backend.export3d import decode_scene_png, encode_scene
from backend.export_queue import session
from backend.horizon_map import render_map, render_profile
from backend.models import (
    Queue2DRequest,
    Queue3DRequest,
    QueueMapRequest,
    QueueProfileRequest,
    SceneExportRequest,
)
from backend.rendering import amplitude, render


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
    section = survey.section(state.view_type, state.section_number)
    _, lo, hi = amplitude(section[2], state.seismic)
    data = render(survey, horizons, state, settings)
    location = {"inline" if inline else "crossline": state.section_number}
    summary = {
        **location,
        "horizons": [h.name for h in visible],
        "horizon_styles": [h.model_dump() for h in state.horizons],
        "seismic_colormap": state.seismic.colormap,
        "reverse_colormap": state.seismic.reverse_colormap,
        "clip_mode": state.seismic.clip_mode,
        "clip_percentile": state.seismic.clip_percentile,
        "symmetric": state.seismic.symmetric,
        "vmin": state.seismic.vmin,
        "vmax": state.seismic.vmax,
        "colorbar_range": [lo, hi],
        "reverse_polarity": state.seismic.reverse_polarity,
        "x_range": list(state.x_range) if state.x_range else None,
        "time_range": list(state.time_range) if state.time_range else None,
        "aspect_ratio_2d": list(state.aspect_ratio_2d) if state.aspect_ratio_2d else None,
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
    )


def add_map(survey, horizons, req: QueueMapRequest) -> dict:
    state, settings = req.state, req.settings
    if state.horizon not in horizons:
        raise ValueError("Horizon not found.")
    horizon = horizons[state.horizon]
    dataset = dataset_label(survey, req.dataset)
    #: Filename scalar position names the active color variable.
    scalar = {"twt": "TWT", "amplitude": "Amplitude", "difference": "Diff"}[state.color_by]
    display = naming.display_label(state.display)
    colormap = naming.colormap_label(state.colormap, "Petrel")
    filename = naming.horizon_map_name(
        dataset,
        horizon.name,
        scalar,
        display,
        colormap,
        settings.width,
        settings.height,
        settings.dpi,
        settings.format,
    )
    data = render_map(survey, horizon, state, settings, horizons)
    summary = {
        "horizon": horizon.name,
        "color_by": state.color_by,
        "clip_percentile": state.clip_percentile,
        "scalar": scalar,
        "difference": (
            {
                "reference": state.difference_reference,
                "comparison": state.difference_comparison,
                "type": state.difference_type,
            }
            if state.color_by == "difference"
            else None
        ),
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
        view_state=state.model_dump(),
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
    )
    filename = naming.map_profile_name(
        dataset,
        horizon.name,
        "Seismic",
        naming.colormap_label(req.colormap, "Seismic"),
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
        "colormap": req.colormap,
        "reverse_colormap": req.reverse_colormap,
        "overlays": info["curves"] if req.show_curves else [],
        "show_curves": req.show_curves,
        "show_legend": req.show_legend,
        "show_ab": req.show_ab,
        "amplitude_range": [-info["vmax"], info["vmax"]],
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
        filename = naming.horizon_surface_name(
            dataset,
            naming.horizons_label([h.name for h in surfaces]) or content or "Horizons",
            "TWT",
            naming.colormap_label(
                surfaces[0].horizon_colormap if surfaces else "petrel", "Petrel"
            ),
            settings.width,
            settings.height,
            settings.dpi,
            req.format,
        )
    request = SceneExportRequest(
        png=req.png,
        format=req.format,
        width=req.width_px,
        height=req.height_px,
        scale=req.scale,
    )
    raw, pixels, size = decode_scene_png(request)
    data = encode_scene(request, raw, pixels, size)
    summary = {
        "slices": slice_positions,
        "interpolation": state.seismic.interpolation,
        "horizons": [h.model_dump() for h in state.horizons],
        "horizon_names": [h.name for h in state.horizons],
        "surface_horizons": [h.name for h in surfaces],
        "camera": state.scene.camera,
        "lighting": any(h.lighting for h in state.horizons),
        "opacity": {h.name: h.opacity for h in state.horizons},
        "vertical_exaggeration": state.scene.aspect_ratio[2],
        "aspect_ratio": list(state.scene.aspect_ratio),
        "quality": state.scene.quality,
        "background": state.scene.background,
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
