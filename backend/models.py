from typing import Literal
from pydantic import BaseModel as PydanticBaseModel, ConfigDict, Field, model_validator


class BaseModel(PydanticBaseModel):
    model_config = ConfigDict(allow_inf_nan=False)


class Seismic(BaseModel):
    colormap: Literal[
        "gray",
        "Greys",
        "binary",
        "seismic",
        "red_white_blue",
        "RdBu",
        "coolwarm",
        "viridis",
        "turbo",
    ] = "seismic"
    reverse_colormap: bool = False
    clip_mode: Literal["percentile", "manual"] = "percentile"
    clip_percentile: float = Field(99.5, gt=0, le=100)
    symmetric: bool = True
    vmin: float | None = None
    vmax: float | None = None
    reverse_polarity: bool = False


class Line(BaseModel):
    visible: bool = True
    width: float = Field(1.5, ge=0.2, le=6)
    style: Literal["solid", "dashed", "dotted", "dashdot", "none"] = "solid"


class Marker(BaseModel):
    visible: bool = False
    shape: Literal[
        "circle", "square", "triangle", "diamond", "cross", "plus", "none"
    ] = "circle"
    size: float = Field(3, ge=1, le=15)


class Outline(BaseModel):
    enabled: bool = True
    width: float = Field(0.5, ge=0, le=4)


class HorizonStyle(BaseModel):
    id: str
    name: str
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
    seismic: Seismic = Field(default_factory=Seismic)
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
    width: float = Field(180, ge=40, le=500)
    height: float = Field(100, ge=30, le=500)
    dpi: Literal[300, 600] = 300
    font: Literal["DejaVu Sans", "DejaVu Serif", "Arial", "Times New Roman"] = (
        "DejaVu Sans"
    )
    font_size: float = Field(10, ge=5, le=30)
    show_axes: bool = True
    show_labels: bool = True
    show_title: bool = True
    format: Literal["png", "pdf", "svg"] = "png"

    @model_validator(mode="after")
    def pixels(self):
        if self.width * self.height * (self.dpi / 25.4) ** 2 > 40_000_000:
            raise ValueError("Export exceeds 40 megapixels. Reduce dimensions or DPI.")
        return self


class ExportRequest(BaseModel):
    state: ViewState
    settings: Settings


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
    display_mode: Literal["full_surface", "slice_intersections"] = "slice_intersections"
    opacity: float = Field(1, ge=0, le=1)
    color_by: Literal["twt", "solid"] = "twt"
    horizon_colormap: Literal["petrel"] = "petrel"
    smooth_shading: bool = True
    lighting: bool = True
    twt_range: tuple[float, float] | None = None
    surface_mode: Literal["surface", "wireframe", "surface_wireframe"] = "surface"
    wireframe_width: float = Field(1, ge=0.2, le=6)
    time_slice_tolerance: float = Field(4, ge=0, le=1000)


class SceneState(BaseModel):
    show_axes: bool = True
    show_axis_labels: bool = True
    show_bounding_box: bool = True
    aspect_ratio: tuple[float, float, float] = (1, 1, 0.7)
    quality: Literal[128, 256, 512] = 256
    background: str = Field("#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")

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
