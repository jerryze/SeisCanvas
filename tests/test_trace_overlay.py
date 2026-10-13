"""Original-amplitude trace geometry, screen sampling and publication parity."""

from collections import OrderedDict
import io
import xml.etree.ElementTree as ET

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from backend.models import HorizonStyle, SectionRequest, Seismic, Settings, ViewState
from backend.rendering import amplitude, render
from backend.section_service import interactive_section
from backend.trace_overlay import aligned_raster, build_trace_overlay, coordinate_edges


class SectionSurvey:
    def __init__(self, x, time, z):
        self.x, self.time = np.asarray(x, dtype=float), np.asarray(time, dtype=float)
        self.z = np.asarray(z, dtype=np.float32)
        self.calls = 0
        self.render_cache = OrderedDict()

    def section(self, mode, number):
        self.calls += 1
        return self.x, self.time, self.z


def state(**seismic):
    return ViewState(section_number=1, trace_viewport_width=1000,
                     seismic=Seismic(clip_mode="manual", vmin=-1, vmax=1, **seismic))


def segments(path):
    result, points = [], []
    for x, time in zip(path["x"], path["time"]):
        if x is None:
            result.append(points)
            points = []
        else:
            points.append((x, time))
    if points:
        result.append(points)
    return result


def test_defaults_and_numeric_validation_preserve_legacy_display():
    s = Seismic()
    assert (s.wiggle, s.variable_area, s.wiggle_gain, s.variable_area_color) == (False, False, 1.0, "#000000")
    assert ViewState(section_number=1).trace_viewport_width is None
    for gain in (-1, 101, float("nan"), float("inf")):
        with pytest.raises(ValidationError):
            Seismic(wiggle_gain=gain)
    for width in (0, -1, 16001, float("inf")):
        with pytest.raises(ValidationError):
            ViewState(section_number=1, trace_viewport_width=width)
    with pytest.raises(ValidationError):
        Seismic(variable_area_color="black")


def test_original_trace_centres_and_twt_samples_have_exact_offsets():
    survey = SectionSurvey([10, 14, 18], [100, 104, 108], [[-1, 0, 1], [0, 1, -1], [1, -1, 0]])
    overlay = build_trace_overlay(survey.x, survey.time, survey.z, state(wiggle=True), -1, 1)
    paths = segments(overlay["wiggle"])
    assert paths[0] == [(8, 100), (10, 104), (12, 108)]
    assert paths[1] == [(14, 100), (16, 104), (14, 106), (12, 108)]
    assert overlay["variable_area"] == {"x": [], "time": []}
    assert overlay["trace_step"] == 1 and overlay["trace_count"] == 3
    np.testing.assert_array_equal(survey.z, [[-1, 0, 1], [0, 1, -1], [1, -1, 0]])


def test_gain_clipping_polarity_and_true_crossings_share_one_geometry():
    x, time = np.array([30, 34]), np.array([200, 204, 208])
    raw = np.array([[0, 0], [4, -4], [-4, 4]], dtype=float)
    view = ViewState(section_number=1, seismic=Seismic(
        wiggle=True, variable_area=True, wiggle_gain=2,
        clip_mode="manual", vmin=-2, vmax=2))
    z, lo, hi = amplitude(raw, view.seismic)
    normal = build_trace_overlay(x, time, z, view, lo, hi)
    first = segments(normal["wiggle"])[0]
    assert first == [(30, 200), (34, 202), (34, 204), (34, 205), (30, 206), (26, 207), (26, 208)]
    first_area = segments(normal["variable_area"])[0]
    assert first_area[0] == first_area[-1] == (30, 200)
    assert first_area[-2] == (30, 206)
    assert all(at <= 206 and xx >= 30 for xx, at in first_area)
    view.seismic.reverse_polarity = True
    inverted_z, lo, hi = amplitude(raw, view.seismic)
    inverted = build_trace_overlay(x, time, inverted_z, view, lo, hi)
    inverted_area = segments(inverted["variable_area"])[0]
    assert inverted_area[0] == (30, 206) and inverted_area[-2] == (30, 208)
    assert (34, 208) in inverted_area
    np.testing.assert_array_equal(raw, [[0, 0], [4, -4], [-4, 4]])


def test_positive_area_uses_original_zero_crossing_after_asymmetric_clipping():
    # -2 to +6 crosses zero at TWT201, even after the positive end clips at2.
    x, time, z = np.array([10]), np.array([200, 204, 208]), np.array([[-2], [6], [-2]])
    view = ViewState(section_number=1, seismic=Seismic(wiggle=True, variable_area=True,
                    clip_mode="manual", vmin=-1, vmax=2))
    overlay = build_trace_overlay(x, time, z, view, -1, 2)
    polygon = segments(overlay["variable_area"])[0]
    assert polygon[0] == polygon[-1] == (10, 201)
    assert polygon[-2] == (10, 207)
    assert (10, 201) in segments(overlay["wiggle"])[0]
    assert (10, 207) in segments(overlay["wiggle"])[0]


def test_zero_is_a_baseline_for_one_sided_manual_colour_limits_and_zero_gain():
    x, time, z = np.array([10]), np.array([200, 204, 208]), np.array([[0], [1], [0]])
    view = state(wiggle=True, variable_area=True)
    view.seismic.vmin, view.seismic.vmax = 0.5, 2
    overlay = build_trace_overlay(x, time, z, view, 0.5, 2)
    assert segments(overlay["wiggle"])[0][0] == (10, 200)
    assert segments(overlay["wiggle"])[0][-1] == (10, 208)
    view.seismic.wiggle_gain = 0
    zero = build_trace_overlay(x, time, z, view, 0.5, 2)
    assert set(zero["wiggle"]["x"]) == {10}
    assert zero["variable_area"]["x"] == []


def test_nonfinite_samples_split_wiggles_and_lobes_without_gap_bridges():
    x, time = np.array([10]), np.arange(6) * 4
    z = np.array([[-1], [1], [np.nan], [1], [-1], [np.inf]])
    view = state(wiggle=True, variable_area=True)
    overlay = build_trace_overlay(x, time, z, view, -1, 1)
    lines, lobes = segments(overlay["wiggle"]), segments(overlay["variable_area"])
    assert len(lines) == len(lobes) == 2
    assert max(at for _, at in lines[0]) == 4
    assert min(at for _, at in lines[1]) == 12
    assert all(np.isfinite(xx) and np.isfinite(at) for path in lines + lobes for xx, at in path)


def test_density_uses_css_width_is_globally_anchored_and_zoom_restores_all_traces():
    x = np.arange(1001) * 4
    time, z = np.array([200, 204]), np.zeros((2, len(x)))
    view = state(wiggle=True)
    full = build_trace_overlay(x, time, z, view, -1, 1)
    assert full["trace_step"] == 13
    assert full["trace_count"] < 90
    view.x_range = (400, 440)
    zoomed = build_trace_overlay(x, time, z, view, -1, 1)
    assert zoomed["trace_step"] == 1
    assert {(baseline, 200) for baseline in range(400, 441, 4)}.issubset(set(segments(zoomed["wiggle"])[i][0] for i in range(zoomed["trace_count"])))
    view.x_range = (400, 1200)
    before = build_trace_overlay(x, time, z, view, -1, 1)
    view.x_range = (404, 1204)
    after = build_trace_overlay(x, time, z, view, -1, 1)
    assert before["trace_step"] == after["trace_step"] == 3
    assert all(round(path[0][0] / 4) % 3 == 0 for path in segments(after["wiggle"]))
    assert set(before["wiggle"]["x"]) & set(after["wiggle"]["x"])


def test_gain_reaches_into_view_and_time_boundary_keeps_continuous_lobe():
    x, time = np.array([0, 4, 8, 12]), np.array([0, 4, 8])
    z = np.array([[1, 1, 1, 1], [1, 1, 1, 1], [-1, -1, -1, -1]])
    view = state(wiggle=True, variable_area=True, wiggle_gain=4)
    view.x_range, view.time_range = (7, 8), (1, 3)
    overlay = build_trace_overlay(x, time, z, view, -1, 1)
    assert (8, 0) in segments(overlay["wiggle"])[0]  # baseline0 offsets into viewport
    assert overlay["trace_count"] == 4
    assert all(min(at for _, at in poly) <= 1 and max(at for _, at in poly) >= 3
               for poly in segments(overlay["variable_area"]))


def test_aligned_raster_handles_irregular_coordinates_and_four_ms_samples():
    x, time = np.array([30, 33, 38]), np.array([200, 204, 208, 212])
    z = time[:, None] * 2 + x[None, :] * 3
    raster, gx, gt, extent = aligned_raster(x, time, z, 100, 80, "bilinear")
    assert extent == (28.5, 40.5, 198, 214)
    inside = np.ix_((gt >= 200) & (gt <= 212), (gx >= 30) & (gx <= 38))
    expected = gt[:, None] * 2 + gx[None, :] * 3
    np.testing.assert_allclose(raster[inside], expected[inside], atol=0.0001)
    assert coordinate_edges(time) == (198, 214)


def test_aligned_nearest_downsample_uses_world_pixel_centres():
    x, time = np.arange(10) * 4, np.array([0])
    raster, gx, _, extent = aligned_raster(x, time, np.arange(10)[None, :], 3, 1, "nearest")
    np.testing.assert_array_equal(raster, [[1, 5, 8]])
    np.testing.assert_allclose(gx, [-2 + 20 / 3, 18, 38 - 20 / 3])
    assert extent[:2] == (-2, 38)


def test_interactive_reuses_one_original_section_and_off_path_has_no_overlay():
    survey = SectionSurvey([30, 33, 38], [200, 204, 208, 212], np.arange(12).reshape(4, 3))
    default = interactive_section(survey, {}, SectionRequest(section_number=1))
    assert survey.calls == 1
    assert "trace_overlay" not in default and "raster_extent" not in default
    np.testing.assert_allclose(default["x"], [30, 34, 38])
    enabled = interactive_section(survey, {}, SectionRequest(section_number=1,
                seismic={"wiggle": True, "variable_area": True}, target_width=24, target_height=24))
    assert survey.calls == 2
    assert enabled["trace_overlay"]["trace_count"] == 3
    assert enabled["raster_extent"] == [28.5, 40.5, 198, 214]
    # Repeat the cached raster path and compare its coordinates and geometry.
    again = interactive_section(survey, {}, SectionRequest(section_number=1,
                seismic={"wiggle": True, "variable_area": True}, target_width=24, target_height=24))
    assert enabled == again


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
@pytest.mark.parametrize("canvas", ["fit", "fixed"])
def test_exports_preserve_shared_paths_layer_order_and_alignment(fmt, canvas, monkeypatch):
    from matplotlib.figure import Figure
    from matplotlib.collections import LineCollection, PolyCollection
    captured = []

    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        captured.append(fig)
        return fig

    monkeypatch.setattr("backend.rendering.Figure", capture)
    survey = SectionSurvey([30, 33, 38], [200, 204, 208, 212],
                           [[-1, 0, 1], [1, -1, 0], [-1, 1, 0], [1, 0, -1]])
    class Horizon:
        def section(self, mode, number):
            return [[30, 204], [38, 206]]
    view = state(wiggle=True, variable_area=True)
    view.horizons = [HorizonStyle(id="h", name="h")]
    expected = build_trace_overlay(survey.x, survey.time, survey.z, view, -1, 1)
    settings = Settings(canvas=canvas, long_edge=600, width=60, height=40, format=fmt)
    output = render(survey, {"h": Horizon()}, view, settings)
    assert survey.calls == 1
    ax = captured[-1].axes[0]
    image = ax.images[0]
    area, wiggle = ax.collections
    assert isinstance(area, PolyCollection) and isinstance(wiggle, LineCollection)
    assert image.get_zorder() < area.get_zorder() < wiggle.get_zorder() < min(line.get_zorder() for line in ax.lines) < ax.xaxis.get_zorder()
    for actual, expected_line in zip(wiggle.get_segments(), segments(expected["wiggle"])):
        np.testing.assert_allclose(actual, expected_line)
    assert list(image.get_extent()) == [28.5, 40.5, 198, 214]
    assert ax.get_xlim() == (28.5, 40.5) and ax.get_ylim() == (212, 200)
    assert not area.get_rasterized() and not wiggle.get_rasterized()
    if fmt == "png":
        with Image.open(io.BytesIO(output)) as png:
            assert png.width > 0 and png.height > 0
    elif fmt == "svg":
        root = ET.fromstring(output)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        assert root.findall(".//svg:image", ns)
        assert b"PolyCollection" in output and b"LineCollection" in output
    else:
        assert output.startswith(b"%PDF")


def test_export_dpi_and_long_edge_do_not_change_trace_selection(monkeypatch):
    import backend.rendering as renderer
    overlays = []
    original = renderer.build_trace_overlay
    def capture(*args):
        result = original(*args)
        overlays.append(result)
        return result
    monkeypatch.setattr(renderer, "build_trace_overlay", capture)
    survey = SectionSurvey(np.arange(1001), [200, 204], np.zeros((2, 1001)))
    view = state(wiggle=True, variable_area=True)
    for dpi, edge in ((300, 600), (600, 900)):
        render(survey, {}, view, Settings(canvas="fit", dpi=dpi, long_edge=edge, format="svg"))
    assert overlays[0] == overlays[1]
