"""SG geometry, original pick isolation, segmentation, caching and vector export."""
from collections import OrderedDict
import io
import xml.etree.ElementTree as ET

import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from backend.horizon import Horizon
from backend import horizon_display as hd, rendering
from backend.models import HorizonStyle, SectionRequest, Seismic, Settings, ViewState
from backend.trace_overlay import coordinate_edges
from backend.section_service import interactive_section


class Survey:
    def __init__(self):
        self.x = np.arange(31, dtype=float)
        self.time = np.arange(190, 231, dtype=float)
        self.z = np.zeros((len(self.time), len(self.x)))
        self.render_cache = OrderedDict()

    def section(self, mode, number):
        return self.x, self.time, self.z


@pytest.fixture
def picks(tmp_path):
    x = np.arange(31)
    y = 205.125 + x * 0.2 + 2 * np.where(x % 2, 1, -1)
    path = tmp_path / "sg.txt"
    path.write_text("\n".join(f"10 {a} {b}" for a, b in zip(x, y)))
    return Horizon(path)


def request(**patch):
    return SectionRequest(section_number=10, horizons=[HorizonStyle(id="h", name="H", color="#123456")],
                          seismic=Seismic(background_interpolation=False), **patch)


@pytest.mark.parametrize("window", hd.SG_WINDOWS)
def test_all_windows_preserve_quadratic_trends_including_edges_and_reduce_jitter(window):
    x = np.arange(41, dtype=float) * 3 + 100
    trend = 500.125 + 0.13 * x + 0.001 * x**2
    points = np.column_stack((x, trend))
    np.testing.assert_allclose(hd.sg_points(points, window, 3), points, atol=1e-9)
    jitter = 2 * np.where(np.arange(len(x)) % 2, 1, -1)
    raw = np.column_stack((x, trend + jitter))
    before = raw.copy()
    display = hd.sg_points(raw, window, 3)
    np.testing.assert_array_equal(display[:, 0], x)
    assert np.std((display[:, 1] - trend)[window:-window]) < np.std(jitter) * 0.4
    assert np.any(display[:, 1] != np.round(display[:, 1]))
    np.testing.assert_array_equal(raw, before)


def test_five_trace_filter_matches_known_sg_coefficients():
    y = np.array([3, 7, 2, 9, 1, 8, 4, 6, 5], dtype=float)
    points = np.column_stack((np.arange(len(y)), y))
    result = hd.sg_points(points, 5, 1)
    expected = np.convolve(y, np.array([-3, 12, 17, 12, -3]) / 35, mode="valid")
    np.testing.assert_allclose(result[2:-2, 1], expected, atol=1e-12)


@pytest.mark.parametrize("n,window", [(0, 7), (1, 7), (2, 15), (3, 7), (4, 7), (6, 15)])
def test_short_segments_shrink_to_an_odd_window_or_keep_raw(n, window):
    raw = np.column_stack((np.arange(n), np.arange(n)**2 + 200.125))
    np.testing.assert_allclose(hd.sg_points(raw, window, 1), raw, atol=1e-10)


def test_sorting_gaps_invalid_values_duplicates_and_irregular_coordinates():
    left = np.column_stack((np.arange(7), [1, 3, 2, 5, 1, 4, 2]))
    right = np.column_stack((np.arange(12, 19), [101, 103, 102, 105, 101, 104, 102]))
    mixed = np.concatenate((left, right))[[10, 0, 8, 3, 7, 4, 5, 6, 1, 2, 9, 11, 12, 13]]
    result = hd.sg_points(mixed, 7, 1)
    assert np.isnan(result[7]).all()
    np.testing.assert_allclose(result[:7], hd.sg_points(left, 7, 1))
    np.testing.assert_allclose(result[8:], hd.sg_points(right, 7, 1))
    with_invalid_time = np.vstack((left, [7, np.nan], right))
    result = hd.sg_points(with_invalid_time, 7, 1)
    np.testing.assert_allclose(result[:7], hd.sg_points(left, 7, 1))
    assert np.isnan(result[7, 1])
    unknown_gap = np.vstack((left, [np.nan, np.nan], right))
    result = hd.sg_points(unknown_gap, 7, 1)
    assert np.isnan(result[7]).all()
    irregular = [[0, 1], [1, 4], [3, 2], [6, 9], [10, 3]]
    result = hd.sg_points(irregular, 7, 1)
    np.testing.assert_array_equal(result[np.isfinite(result).all(axis=1)], irregular)
    duplicates = [[0, 1], [1, 3], [1, 7], [2, 4], [3, 2]]
    result = hd.sg_points(duplicates, 7, 1)
    np.testing.assert_allclose(result[np.isfinite(result).all(axis=1)], duplicates, atol=1e-10)


def test_invalid_sg_settings_are_rejected_and_defaults_are_off():
    state = ViewState(section_number=10)
    assert (state.horizon_sg, state.horizon_sg_window) == (False, 7)
    for window in [3, 6, 9, 17]:
        with pytest.raises(ValidationError):
            ViewState(section_number=10, horizon_sg_window=window)
        with pytest.raises(ValueError):
            hd.sg_points([[0, 1]], window)


def test_full_section_cache_reuses_zoom_results_and_invalidates_on_edits(picks, monkeypatch):
    calls = []
    actual = hd.savgol_filter
    def filtered(*args, **kwargs):
        calls.append(args[1])
        return actual(*args, **kwargs)
    monkeypatch.setattr(hd, "savgol_filter", filtered)
    survey = Survey()
    raw = picks.data.copy()
    full = interactive_section(survey, {"h": picks}, request(horizon_sg=True))
    zoom = interactive_section(survey, {"h": picks}, request(horizon_sg=True, x_range=(8, 12), time_range=(200, 215)))
    assert full["horizon_display"] == zoom["horizon_display"]
    assert calls == [7]
    assert full["horizons"] == zoom["horizons"]
    disabled = interactive_section(survey, {"h": picks}, request())
    assert disabled["horizons"] == full["horizons"]
    assert "horizon_display" not in disabled
    for window in [5, 11, 15]:
        interactive_section(survey, {"h": picks}, request(horizon_sg=True, horizon_sg_window=window))
    assert calls == [7, 5, 11, 15]
    np.testing.assert_array_equal(picks.data, raw)
    picks.data[12, 2] += 8
    edited = interactive_section(survey, {"h": picks}, request(horizon_sg=True))
    assert edited["horizon_display"] != full["horizon_display"]
    assert calls[-1] == 7 and len(calls) == 5
    # Direction, position, owner and replacement data must not share stale values.
    assert hd.sg_section(picks, "crossline", 12, 7, survey.x).shape == (1, 2)
    assert hd.sg_section(picks, "inline", 99, 7, survey.x).shape == (0, 2)
    picks.data = raw.copy()
    restored = interactive_section(survey, {"h": picks}, request(horizon_sg=True))
    assert restored["horizon_display"] == full["horizon_display"]
    assert hd.sg_section(picks, "inline", 10, 7, survey.x).flags.writeable is False


def test_horizons_are_independent_and_crossline_smooths_inline_coordinates(picks, tmp_path):
    path = tmp_path / "crossline.txt"
    path.write_text("\n".join(f"{i} 10 {210.25 + 2 * (i % 2)}" for i in range(31)))
    other = Horizon(path)
    points = hd.sg_section(other, "crossline", 10, 7, np.arange(31))
    np.testing.assert_array_equal(points[:, 0], np.arange(31))
    assert not np.array_equal(points[:, 1], other.data[:, 2])
    assert not np.array_equal(points[:, 1], hd.sg_section(picks, "inline", 10, 7, np.arange(31))[:, 1])


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
@pytest.mark.parametrize("pchip", [False, True])
def test_exports_share_sg_line_geometry_and_leave_markers_and_data_raw(picks, monkeypatch, fmt, pchip):
    survey = Survey()
    req = request(horizon_sg=True, horizon_sg_window=11, smooth_horizons=pchip)
    req.horizons[0].marker.visible = True
    original = picks.data.copy()
    original_txt = picks.path.read_bytes()
    expected = np.asarray(interactive_section(survey, {"h": picks}, req)["horizon_display"]["points"]["h"])
    if pchip:
        expected = hd.pchip_display(expected, coordinate_edges(survey.x), 600)
    captured = []
    actual = rendering.draw_horizon
    def draw(ax, points, style, *args, **kwargs):
        captured.append((points.copy(), kwargs["display_points"].copy()))
        result = actual(ax, points, style, *args, **kwargs)
        # Outline and color share the display curve; markers still use native picks.
        np.testing.assert_allclose(ax.lines[-3].get_xydata(), expected)
        np.testing.assert_allclose(ax.lines[-2].get_xydata(), expected)
        np.testing.assert_array_equal(ax.lines[-1].get_xydata(), points)
        return result
    monkeypatch.setattr(rendering, "draw_horizon", draw)
    data = rendering.render(survey, {"h": picks}, req, Settings(format=fmt, long_edge=600))
    np.testing.assert_allclose(captured[0][1], expected)
    np.testing.assert_array_equal(picks.data, original)
    assert picks.path.read_bytes() == original_txt
    if fmt == "png":
        assert Image.open(io.BytesIO(data)).width > 0
    elif fmt == "svg":
        root = ET.fromstring(data)
        assert any("#123456" in p.attrib.get("style", "") and "stroke" in p.attrib.get("style", "")
                   for p in root.iter("{http://www.w3.org/2000/svg}path"))
    else:
        assert data.startswith(b"%PDF")


def test_combined_sg_pchip_export_preserves_knots_and_gaps(picks):
    sg = hd.sg_section(picks, "inline", 10, 7, np.arange(31))
    display = hd.pchip_display(sg, [8, 14], 300)
    for knot in sg:
        np.testing.assert_allclose(display[display[:, 0] == knot[0]][0], knot, atol=1e-10)
    assert len(display) > len(sg)
    gap = np.vstack((sg[:8], [np.nan, np.nan], sg[12:]))
    display = hd.pchip_display(gap, [0, 30], 300)
    assert not ((display[:, 0] > 7) & (display[:, 0] < 12)).any()


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
def test_queue_keeps_sg_settings_and_rendered_files_after_display_changes(client, picks, monkeypatch, fmt):
    import backend.main as server
    survey = Survey()
    monkeypatch.setattr(server, "survey", survey)
    monkeypatch.setattr(server, "horizons", {"h": picks})
    req = request(horizon_sg=True, horizon_sg_window=15)
    response = client.post("/api/export/queue", json={
        "kind": "2d", "dataset": "SG", "state": req.model_dump(),
        "settings": {"format": fmt, "long_edge": 600},
    })
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["view_state"]["horizon_sg"] is True
    assert item["view_state"]["horizon_sg_window"] == 15
    from backend import export_queue
    assert export_queue.session().items[0]["summary"]["horizon_sg_window"] == 15
    original = client.get(f"/api/export/queue/{item['id']}/file").content
    assert client.post("/api/section", json=request().model_dump()).status_code == 200
    assert client.get(f"/api/export/queue/{item['id']}/file").content == original
