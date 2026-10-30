"""Navigation fallbacks never change detailed scientific rendering results."""

from types import SimpleNamespace

import numpy as np
import pytest

from backend import resample
from backend.horizon_geometry import HorizonGeometry
from backend.horizon_map import _profile_data, map_profile
from backend.models import HorizonMapState, HorizonProfileRequest, SectionRequest, ViewState
from backend.section_service import OVERVIEW_BUDGET, interactive_section, section_overview
from backend.segy import ArrayCache
from backend.trace_overlay import reconstruction_extent


class RecordingSource:
    def __init__(self, shape, values=None):
        self.shape, self.dtype = shape, np.dtype(np.float64)
        self.values, self.reads = values, []

    def __array__(self, *args, **kwargs):
        raise AssertionError("An overview cannot materialize the complete native section")

    def read(self, rows, columns):
        assert len(rows) * len(columns) <= resample.WINDOW_READ_ELEMENTS
        self.reads.append((rows.copy(), columns.copy()))
        if self.values is not None:
            return self.values[np.ix_(rows, columns)]
        return rows[:, None].astype(float) * 1.23456789123 - columns[None, :] * 0.98765432198


def survey_cache():
    return SimpleNamespace(render_cache=ArrayCache(max_bytes=4 * 1024 * 1024))


@pytest.mark.parametrize("interpolate", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_overview_is_opt_in_and_does_not_change_final_section(wide_cube, horizon, interpolate, reverse):
    request = SectionRequest(
        section_number=12, x_range=(39.2, 70.4), time_range=(217.3, 251.8),
        target_width=73, target_height=51, trace_viewport_width=340, trace_viewport_height=80,
        seismic={"background_interpolation": interpolate, "reverse_polarity": reverse,
                 "symmetric": False, "clip_percentile": 81.3, "wiggle": True, "variable_area": True},
    )
    expected = interactive_section(wide_cube, {"h": horizon}, request)
    assert "overview" not in expected
    actual = interactive_section(wide_cube, {"h": horizon}, request.model_copy(update={"include_overview": True}))
    overview = actual.pop("overview")
    assert actual == expected
    x, t, native = wide_cube.section("inline", 12)
    assert overview["raster_extent"] == list(reconstruction_extent(x, t))
    assert np.asarray(overview["z"]).size <= OVERVIEW_BUDGET
    if not interpolate:
        np.testing.assert_array_equal(overview["z"], native)
    panned = request.model_copy(update={"include_overview": True, "x_range": (70.4, 84.1), "time_range": (244, 256)})
    assert interactive_section(wide_cube, {}, panned)["overview"] == overview


def test_native_overview_selects_original_samples_with_bounded_sparse_reads(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Native navigation must not interpolate amplitudes")
    monkeypatch.setattr(resample, "seismic_raster", forbidden)
    source = RecordingSource((30_001, 12_003))
    x, t = np.arange(source.shape[1], dtype=float) ** 1.1, np.arange(source.shape[0]) * 4.0 + 200
    survey = survey_cache()
    result = section_overview(survey, x, t, source, False, ("inline", 20))
    rows, columns = source.reads[0]
    assert len(source.reads) == 1
    assert len(rows) * len(columns) <= OVERVIEW_BUDGET
    np.testing.assert_array_equal(result["x"], x[columns])
    np.testing.assert_array_equal(result["time"], t[rows])
    np.testing.assert_array_equal(result["z"], rows[:, None] * 1.23456789123 - columns[None, :] * 0.98765432198)
    assert result["raster_extent"] == list(reconstruction_extent(x, t))
    assert [result["x_edges"][0], result["x_edges"][-1], result["time_edges"][0], result["time_edges"][-1]] == result["raster_extent"]
    assert section_overview(survey, x, t, source, False, ("inline", 20)) == result
    assert len(source.reads) == 1
    assert sum(ArrayCache.size(value) for value in survey.render_cache.values()) <= survey.render_cache.max_bytes


@pytest.mark.parametrize("shape", [(1, 1), (1, 10_000), (10_000, 1)])
def test_singleton_axes_keep_the_complete_native_cell_extent(shape):
    source = RecordingSource(shape)
    x, t = np.arange(shape[1], dtype=float), np.arange(shape[0], dtype=float)
    result = section_overview(survey_cache(), x, t, source, False, ("singleton", shape))
    assert result["raster_extent"] == [-0.5, shape[1] - 0.5, -0.5, shape[0] - 0.5]
    assert len(result["x_edges"]) == len(result["x"]) + 1
    assert len(result["time_edges"]) == len(result["time"]) + 1
    assert np.asarray(result["z"]).size <= OVERVIEW_BUDGET


def test_interpolated_overview_reuses_original_sinc_kernel_and_preserves_gaps():
    values = np.random.default_rng(17).standard_normal((480, 760))
    values[100:160, 200:250] = np.nan
    x, t = np.arange(760.0), np.arange(480.0) * 4 + 200
    source, survey = RecordingSource(values.shape, values), survey_cache()
    result = section_overview(survey, x, t, source, True, ("inline", 10))
    expected, expected_x, expected_time, _ = resample.seismic_raster(
        x, t, values, len(result["x"]), len(result["time"]), result["raster_extent"],
    )
    np.testing.assert_array_equal(np.asarray(result["z"], dtype=float), expected)
    np.testing.assert_array_equal(result["x"], expected_x)
    np.testing.assert_array_equal(result["time"], expected_time)
    assert any(value is None for row in result["z"] for value in row)
    read_count = len(source.reads)
    assert section_overview(survey, x, t, source, True, ("inline", 10)) == result
    assert len(source.reads) == read_count
    section_overview(survey, x, t, source, True, ("inline", 12))
    assert len(source.reads) > read_count


@pytest.mark.parametrize("interpolate", [False, True])
def test_profile_overview_covers_extended_path_without_changing_final_raster(cube, horizon, interpolate):
    state = ViewState(section_number=0, x_range=(2, 4), time_range=(204, 208),
                      seismic={"background_interpolation": interpolate, "reverse_polarity": True})
    args = (cube, horizon, HorizonMapState(horizon="h"), {"h": horizon}, (10, 30), (12, 38))
    expected = map_profile(*args, target_width=120, target_height=80, display_state=state)
    actual = map_profile(*args, target_width=120, target_height=80, display_state=state, include_overview=True)
    overview = actual.pop("overview")
    assert actual == expected
    d = _profile_data(cube, args[2], args[3], args[4], args[5], display_state=state)
    assert overview["raster_extent"] == list(reconstruction_extent(d["native_distance"], d["native_time"]))
    assert overview["raster_extent"][0] <= expected["x_range"][0]
    assert overview["raster_extent"][1] >= expected["x_range"][1]
    assert overview["raster_extent"][2] <= expected["time_range"][0]
    assert overview["raster_extent"][3] >= expected["time_range"][1]
    assert np.asarray(overview["z"]).size <= OVERVIEW_BUDGET
    if not interpolate:
        np.testing.assert_array_equal(overview["z"], d["native_amplitude"])
    panned = state.model_copy(update={"x_range": (4, 6), "time_range": (208, 211)})
    assert map_profile(*args, display_state=panned, include_overview=True)["overview"] == overview


def test_horizon_only_requests_never_add_a_synthetic_amplitude_overview(horizon):
    geometry = HorizonGeometry({"h": horizon})
    result = interactive_section(geometry, {"h": horizon}, SectionRequest(section_number=10, include_overview=True))
    assert result["has_seismic"] is False and "overview" not in result
    result = map_profile(geometry, horizon, HorizonMapState(horizon="h"), {"h": horizon},
                         (10, 30), (12, 33), include_overview=True)
    assert result["has_seismic"] is False and "overview" not in result


def test_endpoint_models_keep_overview_opt_in():
    assert not SectionRequest(section_number=10).include_overview
    assert not HorizonProfileRequest(state={"horizon": "h"}, a=(10, 30), b=(12, 38)).include_overview


def test_both_viewer_endpoints_accept_overview_requests(client):
    for url, body in [
        ("/api/section", {"section_number": 10}),
        ("/api/horizon-map/profile", {"state": {"horizon": "h"}, "a": [10, 30], "b": [12, 38]}),
    ]:
        baseline = client.post(url, json=body)
        actual = client.post(url, json={**body, "include_overview": True})
        assert baseline.status_code == actual.status_code == 200
        expected, result = baseline.json(), actual.json()
        assert "overview" not in expected
        assert set(result.pop("overview")) == {"x", "time", "x_edges", "time_edges", "raster_extent", "z"}
        assert result == expected
