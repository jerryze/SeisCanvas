"""Render an export request and register it as an immutable queue item.

``Add to Export`` reads the current viewer state, renders the final figure at the
publication settings and stores the bytes in the active export session.  The item
is detached from the viewer from that moment on.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import Field, model_validator

from backend import naming
from backend.core import amplitude, render
from backend.export3d import SceneExportRequest, decode_scene_png, encode_scene
from backend.export_queue import session
from backend.horizon_map import HorizonMapState, render_map
from backend.models import (
    BaseModel,
    Scene3DSettings,
    Settings,
    ViewState,
    ViewState3D,
)

MAX_SCENE_PIXELS = 24_000_000


class Queue2DRequest(BaseModel):
    kind: Literal["2d"] = "2d"
    dataset: str | None = Field(None, max_length=120)
    state: ViewState
    settings: Settings


class QueueMapRequest(BaseModel):
    kind: Literal["map"] = "map"
    dataset: str | None = Field(None, max_length=120)
    state: HorizonMapState
    settings: Settings


class Queue3DRequest(BaseModel):
    """The browser ships its exact WebGL PNG plus the settings used to draw it."""

    kind: Literal["3d"] = "3d"
    dataset: str | None = Field(None, max_length=120)
    png: str = Field(max_length=135_000_000)
    format: Literal["png", "pdf", "svg"] = "png"
    width_px: int = Field(ge=64, le=4000)
    height_px: int = Field(ge=64, le=4000)
    scale: int = Field(ge=1, le=4)
    settings: Scene3DSettings = Field(default_factory=Scene3DSettings)
    state: ViewState3D

    @model_validator(mode="after")
    def pixels(self):
        if self.width_px * self.height_px * self.scale**2 > MAX_SCENE_PIXELS:
            raise ValueError("3D export exceeds 24 megapixels.")
        return self


QueueAddRequest = Annotated[
    Union[Queue2DRequest, QueueMapRequest, Queue3DRequest],
    Field(discriminator="kind"),
]


class RenameRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def not_blank(self):
        if not self.filename.strip():
            raise ValueError("A file name is required.")
        return self


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
    scalar = "TWT"
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
    data = render_map(horizon, state, settings)
    summary = {
        "horizon": horizon.name,
        "scalar": scalar,
        "display": state.display,
        "colormap": state.colormap,
        "reverse_colormap": state.reverse_colormap,
        "range_mode": state.range_mode,
        "vmin": state.vmin,
        "vmax": state.vmax,
        "contours": state.contours,
        "contour_interval": state.interval,
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
