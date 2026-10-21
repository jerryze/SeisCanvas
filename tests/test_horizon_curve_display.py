"""The smoothing preference is persisted but never changes native/export picks."""
import numpy as np
import pytest
from matplotlib.figure import Figure

from backend.models import HorizonStyle, SectionRequest, ViewState
from backend.rendering import draw_horizon
from backend.section_service import interactive_section


@pytest.mark.parametrize("outline", [False, True])
@pytest.mark.parametrize("width", [0, .5, 2])
def test_hollow_circle_style_roundtrip_and_export(outline, width):
    style = HorizonStyle(id="h", name="H", color="#ff8800",
                         marker={"visible": True, "shape": "circle-open", "size": 5},
                         outline={"enabled": outline, "width": width})
    style = HorizonStyle.model_validate_json(style.model_dump_json())
    ax = Figure().subplots()
    assert draw_horizon(ax, np.array([[30, 204], [33, 205]]), style)
    marker = ax.lines[-1]
    assert marker.get_marker() == "o"
    assert marker.get_markerfacecolor() == "white"
    assert marker.get_markeredgecolor() == style.color
    assert marker.get_markeredgewidth() == max(.75, width if outline else 0)
    assert marker.get_markersize() == 5


def test_display_preference_defaults_off_and_survives_serialization():
    assert ViewState(section_number=10).smooth_horizons is False
    view = ViewState(section_number=10, smooth_horizons=True)
    assert ViewState.model_validate(view.model_dump()).smooth_horizons is True


def test_smoothing_preference_does_not_change_raw_section_or_export(cube, horizon):
    original = horizon.data.copy()
    results = []
    geometries = []
    for smooth in (False, True):
        style = HorizonStyle(id="h", name="H")
        req = SectionRequest(section_number=10, horizons=[style], smooth_horizons=smooth)
        results.append(interactive_section(cube, {"h": horizon}, req)["horizons"])
        ax = Figure().subplots()
        points = np.asarray(horizon.section("inline", 10))
        draw_horizon(ax, points, style)
        geometries.append([line.get_xydata().tolist() for line in ax.lines])
    assert results[0] == results[1] == {"h": [[30, 204], [33, 205]]}
    assert geometries[0] == geometries[1]
    np.testing.assert_array_equal(horizon.data, original)
