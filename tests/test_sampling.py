"""Contracts shared by SEG-Y previews, A–B profiles and horizon amplitudes."""

import numpy as np
import pytest
import segyio

from backend.horizon import Horizon
from backend.horizon_map import map_data, map_profile, sample_seismic_line
from backend.models import HorizonMapState, Seismic, ViewState
from backend import preview
from backend.preview import read_samples, sample_horizon_amplitude, trace_ids_at
from backend.scene import slice_data
from backend.segy import Survey


def make_survey(path, pairs):
    spec = segyio.spec()
    spec.format = 5
    spec.samples = [200, 204, 208]
    spec.tracecount = len(pairs)
    with segyio.create(str(path), spec) as file:
        for trace_id, (inline, crossline) in enumerate(pairs):
            file.header[trace_id] = {
                189: inline, 21: crossline, 109: 200, 117: 4000,
            }
            file.trace[trace_id] = np.arange(3, dtype=np.float32) + inline * 100 + crossline
        file.bin[segyio.BinField.Interval] = 4000
    return Survey(path)


@pytest.fixture
def square_survey(tmp_path):
    return make_survey(tmp_path / "square.segy", [
        (inline, crossline)
        for inline in (10, 12, 14)
        for crossline in (30, 33, 38)
    ])


@pytest.fixture(params=["mmap", "segyio"])
def sampling_backend(request, monkeypatch):
    """Exercise both decoding paths on the same valid fixed-length SEG-Y."""
    if request.param == "segyio":
        # A layout unavailable to the direct reader must use segyio instead.
        monkeypatch.setattr(preview, "SAMPLE_BYTES", {})
    calls = []
    original_open = segyio.open

    def record_open(*args, **kwargs):
        calls.append(args[0])
        return original_open(*args, **kwargs)

    monkeypatch.setattr(segyio, "open", record_open)
    return request.param, calls


def test_equal_trace_and_sample_lengths_have_explicit_modes(square_survey, sampling_backend):
    backend, calls = sampling_backend
    ids = np.array([0, -1, 8])
    shared = read_samples(square_survey, ids, np.arange(3))
    assert shared.shape == (3, 3)
    np.testing.assert_array_equal(shared[0], [1030, 1031, 1032])
    assert np.isnan(shared[1]).all()
    np.testing.assert_array_equal(shared[2], [1438, 1439, 1440])

    points = read_samples(square_survey, ids, np.array([2, 0, 1]), per_point=True)
    assert points.shape == (3,)
    np.testing.assert_allclose(points, [1032, np.nan, 1439], equal_nan=True)
    assert bool(calls) is (backend == "segyio")


def test_sampling_modes_validate_shapes(square_survey):
    with pytest.raises(ValueError, match="Per-point"):
        read_samples(square_survey, [0, 1], [0], per_point=True)
    with pytest.raises(ValueError, match="one-dimensional"):
        read_samples(square_survey, [0, 1], [[0], [1]])


def test_shared_sampling_retains_trace_grid_shape(square_survey, sampling_backend):
    ids = np.array([[0, 1], [3, -1]])
    sampled = read_samples(square_survey, ids, np.array([0, 2]))
    assert sampled.shape == (2, 2, 2)
    np.testing.assert_array_equal(sampled[0], [[1030, 1032], [1033, 1035]])
    np.testing.assert_array_equal(sampled[1, 0], [1230, 1232])
    assert np.isnan(sampled[1, 1]).all()
    assert read_samples(square_survey, np.array([], dtype=int), [0, 2]).shape == (0, 2)


@pytest.mark.parametrize("kind,position,base", [("inline", 12, [1230, 1233, 1238]),
                                                ("crossline", 33, [1033, 1233, 1433])])
def test_square_slice_reads_every_original_sample(square_survey, sampling_backend, kind, position, base):
    data, sampled = slice_data(square_survey, kind, position, maximum=3)
    expected = np.asarray(base)[None, :] + np.arange(3)[:, None]
    np.testing.assert_array_equal(sampled, expected)
    np.testing.assert_array_equal(data["amplitude"], expected)
    assert data["native_shape"] == [3, 3]


def test_square_ab_sampling_keeps_time_and_path_axes(square_survey, sampling_backend):
    inline = np.array([10., 11., 12.])
    crossline = np.array([30., 34., 38.])
    sampled = sample_seismic_line(square_survey, inline, crossline)
    expected = inline[:, None] * 100 + crossline[:, None] + np.arange(3)[None, :]
    np.testing.assert_allclose(sampled, expected)


def test_ab_profile_with_three_path_points_and_three_samples(square_survey, sampling_backend, tmp_path):
    path = tmp_path / "profile-horizon.txt"
    path.write_text("10 30 204\n10 33 204\n10 38 204\n")
    horizon = Horizon(path)
    data = map_profile(
        square_survey, horizon, HorizonMapState(horizon="h"), {"h": horizon},
        (10, 30), (10, 34),
        display_state=ViewState(section_number=0, seismic=Seismic(background_interpolation=False)),
    )
    assert data["native_shape"] == [3, 3]
    expected = 1030 + np.asarray(data["distance"])[None, :] + np.arange(3)[:, None]
    np.testing.assert_allclose(data["amplitude"], expected)


def test_sparse_trace_lookup_supports_unsorted_rows_and_missing_nodes(tmp_path, sampling_backend):
    pairs = [(10, 38), (10, 30), (10, 33)]
    pairs.extend((number, number) for number in range(40) if number != 10)
    survey = make_survey(tmp_path / "sparse.segy", pairs)
    assert survey.trace_lookup is None  # 40 x 40 cells exceed the dense-index limit.
    inline = np.array([10, 10, 10, 9, -1, 40])
    crossline = np.array([30, 33, 38, 33, 30, 38])
    np.testing.assert_array_equal(trace_ids_at(survey, inline, crossline), [1, 2, 0, -1, -1, -1])
    values = sample_horizon_amplitude(survey, inline, crossline, np.full(6, 208))
    np.testing.assert_allclose(values, [1032, 1035, 1040, np.nan, np.nan, np.nan], equal_nan=True)


def test_sparse_duplicate_coordinate_keeps_first_trace_selection(tmp_path):
    pairs = [(10, 38), (10, 30), (10, 30), (10, 33)]
    pairs.extend((number, number) for number in range(40) if number != 10)
    survey = make_survey(tmp_path / "duplicates.segy", pairs)
    assert survey.trace_lookup is None
    np.testing.assert_array_equal(trace_ids_at(survey, [10], [30]), [1])


def test_map_and_surface_share_time_boundaries_and_missing_trace_rules(square_survey, sampling_backend, tmp_path):
    path = tmp_path / "boundaries.txt"
    path.write_text("10 30 200\n10 33 204\n10 38 208\n12 30 206\n12 33 199\n12 38 209\n")
    horizon = Horizon(path)
    result = map_data(square_survey, horizon, HorizonMapState(horizon="h", color_by="amplitude", display="filled"))
    expected = np.array([[1030, 1034, 1040], [1231.5, np.nan, np.nan]])
    grid = np.asarray(result["z"], dtype=float)
    picked_cols = np.searchsorted(result["x"], [30, 33, 38])
    np.testing.assert_allclose(grid[:, picked_cols], expected, equal_nan=True)
    assert np.isnan(grid[:, np.setdiff1d(np.arange(grid.shape[1]), picked_cols)]).all()
    surface = sample_horizon_amplitude(square_survey, horizon.data[:, 0], horizon.data[:, 1], horizon.data[:, 2])
    np.testing.assert_allclose(surface.reshape(2, 3), expected, equal_nan=True)


def test_exact_time_knot_does_not_require_finite_next_sample(square_survey, sampling_backend, tmp_path):
    with segyio.open(str(square_survey.path), "r+", ignore_geometry=True) as file:
        file.trace[0] = np.array([1030., np.nan, 1032.], dtype=np.float32)
    values = sample_horizon_amplitude(square_survey, [10, 10, 10], [30, 30, 30], [200, 202, 208])
    np.testing.assert_allclose(values, [1030, np.nan, 1032], equal_nan=True)
    path = tmp_path / "exact-knot.txt"
    path.write_text("10 30 200\n")
    result = map_data(square_survey, Horizon(path), HorizonMapState(horizon="h", color_by="amplitude", display="filled"))
    assert result["z"] == [[1030]]
