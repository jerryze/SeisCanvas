import json
import re

from typing import Annotated, Literal, Union
from pydantic import BaseModel as PydanticBaseModel, ConfigDict, Field, model_validator, field_validator

from backend.style import CMAPS


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


#: Hard cap for a WebGL figure rasterised on the browser side, in output pixels.
MAX_SCENE_PIXELS = 24_000_000


class Seismic(BaseModel):
    #: Single source of truth is core.CMAPS; validated, not a frozen Literal.
    colormap: str = "seismic"

    @field_validator("colormap")
    @classmethod
    def known_colormap(cls, value):
        if value not in CMAPS:
            raise ValueError(f"Unknown colormap {value!r}; expected one of {CMAPS}.")
        return value
    reverse_colormap: bool = False
    clip_mode: Literal["percentile", "manual"] = "percentile"
    clip_percentile: float = Field(99.5, gt=0, le=100)
    symmetric: bool = True
    vmin: float | None = None
    vmax: float | None = None
    reverse_polarity: bool = False
    #: Compatibility with older saved workspaces; seismic sections use the switches below.
    interpolation: Literal["nearest", "bilinear", "bicubic"] = "bilinear"
    #: Match the render grid to the viewport pixels instead of a fixed grid.
    adaptive_resolution: bool = True
    #: Optional traditional trace overlays; shared amplitudes and colour raster.
    wiggle: bool = False
    variable_area: bool = False
    wiggle_gain: float = Field(1.0, ge=0, le=100)
    variable_area_color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Shared seismic reconstruction for 2D, 3D slices and A–B profiles.
    background_interpolation: bool = True
    wiggle_interpolation: bool = True


class Line(BaseModel):
    visible: bool = True
    width: float = Field(1.5, ge=0.2, le=6)
    style: Literal["solid", "dashed", "dotted", "dashdot", "none"] = "solid"


class Marker(BaseModel):
    visible: bool = False
    shape: Literal[
        "circle", "circle-open", "square", "triangle", "diamond", "cross", "plus", "none"
    ] = "circle"
    size: float = Field(3, ge=1, le=15)


class Outline(BaseModel):
    enabled: bool = True
    width: float = Field(0.5, ge=0, le=4)


class HorizonStyle(BaseModel):
    id: str
    name: str
    model_group: str = Field("", max_length=80)
    horizon_key: str = Field("", max_length=80)

    @field_validator("model_group", "horizon_key")
    @classmethod
    def trimmed_identity(cls, value):
        return value.strip()

    visible: bool = True
    color: str = Field("#e6b450", pattern=r"^#[0-9a-fA-F]{6}$")
    line: Line = Field(default_factory=Line)
    marker: Marker = Field(default_factory=Marker)
    outline: Outline = Field(default_factory=Outline)


class ViewState(BaseModel):
    view_type: Literal["inline", "crossline"] = "inline"
    section_number: int
    x_range: tuple[float, float] | None = None
    time_range: tuple[float, float] | None = None
    aspect_ratio_2d: tuple[float, float] | None = None
    #: Inner 2D axes width in CSS pixels, independent of export resolution/DPI.
    trace_viewport_width: float | None = Field(None, gt=0, le=16000)
    trace_viewport_height: float | None = Field(None, gt=0, le=16000)
    seismic: Seismic = Field(default_factory=Seismic)
    #: Shared 2D display preference; native data and export geometry stay raw.
    smooth_horizons: bool = False
    #: SG is independent of PCHIP and never changes stored horizon picks.
    horizon_sg: bool = False
    horizon_sg_window: Literal[5, 7, 11, 15] = 7
    horizons: list[HorizonStyle] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_ranges(self):
        if self.aspect_ratio_2d is not None and not all(0.1 <= a <= 5 for a in self.aspect_ratio_2d):
            raise ValueError("2D aspect ratios must be between 0.1 and 5.")
        for value in [self.x_range, self.time_range]:
            if value is not None and value[0] >= value[1]:
                raise ValueError(
                    "View ranges must have increasing, distinct endpoints."
                )
        return self


class Settings(BaseModel):
    canvas: Literal["fit", "fixed"] = "fit"
    long_edge: int = Field(3000, ge=600, le=4000)
    # Older clients may still send physical page dimensions.
    @model_validator(mode="before")
    @classmethod
    def legacy_canvas(cls, values):
        if isinstance(values, dict) and "canvas" not in values and any(k in values for k in ("width", "height", "dpi")):
            values = {**values, "canvas": "fixed"}
        return values

    background: Literal["white", "transparent"] = "white"
    width: float = Field(180, ge=40, le=500)
    height: float = Field(100, ge=30, le=500)
    dpi: Literal[300, 600] = 300
    #: Publication text face. Times New Roman is the scientific default.
    font: Literal["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman"] = (
        "Times New Roman"
    )
    font_size: float = Field(10, ge=5, le=30)
    show_axes: bool = True
    show_labels: bool = True
    show_title: bool = True
    format: Literal["png", "pdf", "svg"] = "png"
    #: Scalar-map compatibility; seismic sections use their display switches.
    interpolation: Literal["nearest", "bilinear", "bicubic"] = "bicubic"
    #: ``export`` re-renders the raster at the output pixels, ``view`` reuses
    #: the interactive (viewport matched) render grid.
    resolution: Literal["export", "view"] = "export"

    @model_validator(mode="after")
    def pixels(self):
        if self.canvas == "fixed" and self.width * self.height * (self.dpi / 25.4) ** 2 > 40_000_000:
            raise ValueError("Export exceeds 40 megapixels. Reduce dimensions or DPI.")
        return self

    def canvas_pixels(self) -> tuple[int, int]:
        """Final output pixels for the requested physical size and DPI."""
        return (
            max(1, int(round(self.width / 25.4 * self.dpi))),
            max(1, int(round(self.height / 25.4 * self.dpi))),
        )


class ExportRequest(BaseModel):
    state: ViewState
    settings: Settings


class QueueArchiveRequest(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=1000)


class SliceBorder(BaseModel):
    visible: bool = True
    color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(1, ge=0.2, le=6)


class SliceState(BaseModel):
    id: str
    position: float
    visible: bool = True
    opacity: float = Field(1, ge=0, le=1)
    border: SliceBorder = Field(default_factory=SliceBorder)


class Slices(BaseModel):
    inline: list[SliceState] = Field(default_factory=list, max_length=12)
    crossline: list[SliceState] = Field(default_factory=list, max_length=12)
    time: list[SliceState] = Field(default_factory=list, max_length=12)


class Horizon3DStyle(HorizonStyle):
    display_mode: Literal["full_surface", "slice_intersections"] = "full_surface"
    opacity: float = Field(1, ge=0, le=1)
    color_by: Literal["twt", "amplitude", "solid"] = "twt"
    horizon_colormap: Literal["petrel"] = "petrel"
    smooth_shading: bool = True
    lighting: bool = True
    twt_range: tuple[float, float] | None = None
    time_slice_tolerance: float = Field(4, ge=0, le=1000)


class SceneState(BaseModel):
    show_axes: bool = True
    show_axis_labels: bool = True
    show_bounding_box: bool = True
    aspect_ratio: tuple[float, float, float] = (1, 1, 0.7)
    quality: Literal[128, 256, 512] = 256
    export_long_edge: int | None = Field(None, ge=600, le=4000)
    background: str = Field("#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    #: Plotly camera. The backend never renders it, but the export manifest must
    #: be able to reproduce the exact viewpoint.
    camera: dict | None = None
    #: Transient projected CSS dimensions, supplied by the 3D viewer.
    slice_viewports: dict[str, tuple[float, float]] = Field(default_factory=dict, max_length=18)

    @field_validator("camera")
    @classmethod
    def finite_camera(cls, value):
        try:
            json.dumps(value, allow_nan=False)
        except (ValueError, TypeError) as error:
            raise ValueError("Camera must contain finite JSON values.") from error
        return value

    @field_validator("slice_viewports")
    @classmethod
    def valid_viewports(cls, values):
        if any(not all(0 < size <= 16000 for size in viewport) for viewport in values.values()):
            raise ValueError("Slice viewport dimensions must be between 0 and 16000.")
        return values

    @model_validator(mode="after")
    def valid_aspect(self):
        if not all(0.1 <= a <= 5 for a in self.aspect_ratio):
            raise ValueError("Aspect ratios must be between 0.1 and 5.")
        return self


class ViewState3D(BaseModel):
    view_mode: Literal["3d"] = "3d"
    seismic: Seismic = Field(default_factory=Seismic)
    slices: Slices = Field(default_factory=Slices)
    horizons: list[Horizon3DStyle] = Field(default_factory=list)
    scene: SceneState = Field(default_factory=SceneState)

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [
            s.id
            for kind in ["inline", "crossline", "time"]
            for s in getattr(self.slices, kind)
        ]
        if len(ids) != len(set(ids)):
            raise ValueError("Slice IDs must be unique.")
        if len(ids) > 18:
            raise ValueError("A scene supports up to 18 slices.")
        return self


class Scene3DSettings(BaseModel):
    """Content-fit publication settings, with legacy physical-size compatibility."""

    canvas: Literal["fit", "fixed"] = "fit"
    long_edge: int = Field(3000, ge=600, le=4000)
    # Older clients may still send physical page dimensions.
    @model_validator(mode="before")
    @classmethod
    def legacy_canvas(cls, values):
        if isinstance(values, dict) and "canvas" not in values and any(k in values for k in ("width", "height", "dpi")):
            values = {**values, "canvas": "fixed"}
        return values

    width: float = Field(180, ge=30, le=500)
    height: float = Field(100, ge=20, le=500)
    dpi: Literal[300, 600] = 300
    #: Publication text face. Times New Roman is the scientific default.
    font: Literal["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman"] = (
        "Times New Roman"
    )
    font_size: float = Field(10, ge=5, le=30)
    background: str = Field("white", pattern=r"^(white|transparent|#[0-9a-fA-F]{6})$")
    show_axes: bool = True
    show_axis_labels: bool = True
    show_bounding_box: bool = True

    @model_validator(mode="after")
    def pixels(self):
        # A WebGL figure is exported as a raster image, so cap the pixel budget.
        if self.canvas == "fixed" and self.width * self.height * (self.dpi / 25.4) ** 2 > MAX_SCENE_PIXELS:
            raise ValueError("3D export exceeds 24 megapixels. Reduce dimensions or DPI.")
        return self


class WorkspaceView(ViewState):
    view_mode: Literal["2d", "3d", "map"] = "2d"
    slices: Slices = Field(default_factory=Slices)
    scene: SceneState = Field(default_factory=SceneState)
    horizons: list[Horizon3DStyle] = Field(default_factory=list)


class WorkspaceSave(BaseModel):
    project_id: str
    revision: int = Field(ge=0)
    state: dict

    @field_validator("state")
    @classmethod
    def valid_state(cls, state):
        if state.get("version") != 1:
            raise ValueError("Unsupported workspace state version.")
        if not isinstance(state.get("view"), dict) or not isinstance(state["view"].get("horizons"), list):
            raise ValueError("Workspace view and horizon registry are required.")
        WorkspaceView.model_validate(state.get("view", {}))
        return state


class WorkspaceRelink(BaseModel):
    project_id: str
    horizon_id: str | None = None


# ---------------------------------------------------------------------------
# Endpoint request models, collected here so every API schema lives in one
# module.  The endpoint behaviour stays in main.py and the export services.
# ---------------------------------------------------------------------------


class SectionRequest(ViewState):
    """A viewer request: the visible range comes from ``x_range``/``time_range``."""

    quality: Literal["preview", "interactive", "publication"] = "interactive"
    interpolation: Literal["nearest", "bilinear", "bicubic"] | None = None
    target_width: int | None = Field(None, ge=8, le=8000)
    target_height: int | None = Field(None, ge=8, le=8000)


class SampleRequest(BaseModel):
    """Probe the original SEG-Y for the sample under the cursor."""

    kind: Literal["inline", "crossline", "time"]
    position: float
    inline: float | None = None
    crossline: float | None = None
    time: float | None = None


class LocalSegyRequest(BaseModel):
    geometry_mode: Literal["auto", "regular"] = "auto"
    path: str = Field(min_length=1)
    ilbyte: int = Field(189, ge=1, le=237)
    xlbyte: int = Field(21, ge=1, le=237)


class PickSegyRequest(BaseModel):
    path: str | None = Field(None, min_length=1)
    geometry_mode: Literal["auto", "regular"] = "auto"
    job_id: str | None = Field(None, pattern=r"^[a-zA-Z0-9-]{1,64}$")
    ilbyte: int = Field(189, ge=1, le=237)
    xlbyte: int = Field(21, ge=1, le=237)


class HorizonRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class PickHorizonRequest(BaseModel):
    paths: list[str] = Field(min_length=1, max_length=1000)


class LocalHorizonRequest(BaseModel):
    token: str
    inline_column: int = Field(default=0, ge=0)
    xline_column: int = Field(default=1, ge=0)
    time_column: int = Field(default=2, ge=0)
    model_group: str = Field("", max_length=80)
    horizon_keys: list[Annotated[str, Field(max_length=80)]] | None = None


class SceneVectorPath(BaseModel):
    #: Exact projected glyph/line triangles, expressed in output pixel units.
    points: list[tuple[float, float]] = Field(min_length=3, max_length=4096)
    color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    opacity: float = Field(1, ge=0, le=1)
    layer: Literal["back", "front"] = "front"


class SceneVectorLine(BaseModel):
    points: list[tuple[float, float]] = Field(min_length=2, max_length=4096)
    color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    width: float = Field(1, gt=0, le=100)
    opacity: float = Field(1, ge=0, le=1)
    layer: Literal["back", "front"] = "front"


class SceneVectorOverlay(BaseModel):
    paths: list[SceneVectorPath] = Field(default_factory=list, max_length=50_000)
    lines: list[SceneVectorLine] = Field(default_factory=list, max_length=10_000)
    labels: list[Annotated[str, Field(max_length=500)]] = Field(default_factory=list, max_length=1000)

    @model_validator(mode="after")
    def bounded_vertices(self):
        if sum(len(item.points) for item in [*self.paths, *self.lines]) > 500_000:
            raise ValueError("3D vector furniture exceeds 500000 vertices.")
        return self


class SceneExportRequest(BaseModel):
    dpi: float | None = Field(None, ge=1, le=2000)
    png: str = Field(max_length=135_000_000)
    format: Literal["png", "pdf", "svg"]
    width: int = Field(ge=64, le=4000)
    height: int = Field(ge=64, le=4000)
    scale: int = Field(ge=1, le=4)
    background: str = Field("white", pattern=r"^(white|transparent|#[0-9a-fA-F]{6})$")
    vector_overlay: SceneVectorOverlay | None = None


class HorizonMapState(BaseModel):
    @model_validator(mode="before")
    @classmethod
    def automatic_contours(cls, values):
        # UI keeps the last manual interval while automatic spacing is active.
        if isinstance(values, dict) and values.get("interval_auto") is True:
            return {**values, "interval": None}
        return values

    horizon: str
    #: Active color scalar: horizon TWT, seismic amplitude along the horizon,
    #: or the difference between two horizons.
    color_by: Literal["twt", "amplitude", "difference"] = "twt"
    display: Literal["filled", "contour", "filled_contour"] = "filled_contour"
    colormap: Literal[
        "petrel", "turbo", "viridis", "cividis", "jet",
        "seismic", "RdBu", "coolwarm", "magma",
    ] = "petrel"
    reverse_colormap: bool = False
    range_mode: Literal["auto", "manual"] = "auto"
    vmin: float | None = None
    vmax: float | None = None
    #: Amplitude/difference auto range: symmetric +-percentile of |scalar|.
    clip_percentile: float = Field(99.0, gt=0, le=100)
    #: Difference mode: DeltaT = comparison - reference on the current grid.
    difference_reference: str | None = None
    difference_comparison: str | None = None
    difference_type: Literal["signed", "absolute"] = "signed"
    show_statistics: bool = True
    contours: bool = True
    #: Contour interval; ``None`` derives a 1/2/5 step from the scalar range.
    interval: float | None = Field(None, gt=0)
    line_width: float = Field(0.5, ge=0.1, le=6)
    labels: bool = False
    colorbar: bool = True
    x_range: tuple[float, float] | None = None
    y_range: tuple[float, float] | None = None

    @model_validator(mode="after")
    def ranges(self):
        if self.range_mode == "manual" and (self.vmin is None or self.vmax is None or self.vmin >= self.vmax):
            raise ValueError("Manual minimum must be less than maximum.")
        for r in [self.x_range, self.y_range]:
            if r and r[0] >= r[1]:
                raise ValueError("Axis range must be increasing.")
        return self


class MapProfileOverlay(BaseModel):
    a: tuple[float, float]
    b: tuple[float, float]
    path_start: tuple[float, float] | None = None
    path_end: tuple[float, float] | None = None

    @model_validator(mode="after")
    def distinct_endpoints(self):
        if self.a == self.b:
            raise ValueError("Profile end points A and B must be two different positions.")
        return self


class HorizonMapExport(BaseModel):
    state: HorizonMapState
    settings: Settings
    profile: MapProfileOverlay | None = None


class ProfileDisplayState(BaseModel):
    seismic: Seismic | None = None
    x_range: tuple[float, float] | None = None
    time_range: tuple[float, float] | None = None
    aspect_ratio_2d: tuple[float, float] | None = None
    trace_viewport_width: float | None = Field(None, gt=0, le=16000)
    trace_viewport_height: float | None = Field(None, gt=0, le=16000)

    def section_state(self, **fallback):
        return ViewState(section_number=0, **{
            **fallback, **self.model_dump(include={"x_range", "time_range", "aspect_ratio_2d", "trace_viewport_width", "trace_viewport_height"}),
            "seismic": self.seismic or fallback.get("seismic", Seismic()),
        })

    @model_validator(mode="after")
    def valid_profile_display(self):
        self.section_state()
        return self


class HorizonProfileRequest(ProfileDisplayState):
    """A–B horizon profile: sample the map scalars along a straight line."""

    state: HorizonMapState
    #: End points as (inline, crossline) in survey grid units; both may sit
    #: between grid nodes (bilinear) but must be two different positions.
    a: tuple[float, float]
    b: tuple[float, float]
    #: Display resampling of the section, mirroring /api/section: when a
    #: target is given the raster is fitted to the subplot's pixels.
    target_width: int | None = Field(None, ge=8, le=8000)
    target_height: int | None = Field(None, ge=8, le=8000)
    interpolation: Literal["nearest", "bilinear", "bicubic"] | None = None


class NamedExport(BaseModel):
    dataset: str | None = Field(None, max_length=120)
    filename: str | None = Field(None, min_length=1, max_length=200)

    @field_validator("filename")
    @classmethod
    def filename_not_blank(cls, value):
        if value is not None and not value.strip():
            raise ValueError("文件名不能为空。")
        return value


class Queue2DRequest(NamedExport):
    kind: Literal["2d"] = "2d"
    state: ViewState
    settings: Settings


class QueueMapRequest(HorizonMapExport, NamedExport):
    kind: Literal["map"] = "map"


class SceneNameRequest(NamedExport):
    """Name a 3D figure before capturing or transferring any pixels."""
    kind: Literal["3d"] = "3d"
    format: Literal["png", "pdf", "svg"] = "png"
    settings: Scene3DSettings = Field(default_factory=Scene3DSettings)
    state: ViewState3D


class Queue3DRequest(SceneNameRequest):
    """The browser ships its exact WebGL PNG plus the settings used to draw it."""

    png: str = Field(max_length=135_000_000)
    width_px: int = Field(ge=64, le=4000)
    height_px: int = Field(ge=64, le=4000)
    scale: int = Field(ge=1, le=4)
    render_dpi: float | None = Field(None, ge=1, le=2000)
    timings: dict[str, float] = Field(default_factory=dict, max_length=20)
    vector_overlay: SceneVectorOverlay | None = None

    @model_validator(mode="after")
    def pixels(self):
        if self.width_px * self.height_px * self.scale**2 > MAX_SCENE_PIXELS:
            raise ValueError("3D export exceeds 24 megapixels.")
        return self


class QueueProfileRequest(ProfileDisplayState, NamedExport):
    """Standalone A–B profile figure: interpolated seismic section + overlays."""

    kind: Literal["profile"] = "profile"
    state: HorizonMapState
    a: tuple[float, float]
    b: tuple[float, float]
    #: Horizon id -> line color, so overlays match the on-screen styles.
    curve_colors: dict[str, str] = Field(default_factory=dict)
    horizons: list[HorizonStyle] | None = Field(None, max_length=512)
    #: Section background colormap, shared with the 2D window display.
    colormap: str = "seismic"
    reverse_colormap: bool = False
    #: Figure furniture, all removable for publication layouts.
    show_curves: bool = True
    show_legend: bool = True
    show_ab: bool = True
    settings: Settings = Field(default_factory=Settings)

    @field_validator("curve_colors")
    @classmethod
    def hex_colors(cls, value):
        for color in value.values():
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(color)):
                raise ValueError(f"Invalid curve color {color!r}.")
        return value


class ExportRestoreSnapshot(BaseModel):
    """Versioned settings only; never contains captured pixels or mutable state."""
    version: Literal[1] = 1
    kind: Literal["2d", "3d", "map", "profile"]
    request: dict
    sources: dict[str, str] | None = None


QueueAddRequest = Annotated[
    Union[Queue2DRequest, QueueMapRequest, Queue3DRequest, QueueProfileRequest],
    Field(discriminator="kind"),
]


ExportNameRequest = Annotated[
    Union[Queue2DRequest, QueueMapRequest, SceneNameRequest, QueueProfileRequest],
    Field(discriminator="kind"),
]


class RenameRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def not_blank(self):
        if not self.filename.strip():
            raise ValueError("A file name is required.")
        return self


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    request_id: str | None = Field(None, pattern=r"^[a-f0-9]{32}$")
    template_id: str | None = Field(None, pattern=r"^[a-f0-9]{32}$")


class ProjectRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class ProjectSwitch(BaseModel):
    target_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    source_revision: int | None = Field(None, ge=0)


class ProjectRelink(BaseModel):
    horizon_id: str | None = None
    path: str | None = None
    confirm: bool = False
    revision: int | None = Field(None, ge=0)
    file_identity: dict[str, str] | None = None
