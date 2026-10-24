"""Bounded slice reads must preserve native geometry and scientific values."""
import numpy as np
import pytest
import segyio
from fastapi.testclient import TestClient

from backend import preview, slice_source
from backend.scene import timeslice
from backend.segy import Survey
from backend.slice_source import SliceSource


def make_survey(path, pairs, *, regular=False, sample_format=5, values=None):
    spec = segyio.spec()
    spec.format = sample_format
    spec.samples = [200, 204, 208, 212]
    spec.tracecount = len(pairs)
    with segyio.create(str(path), spec) as file:
        for trace, (inline, crossline) in enumerate(pairs):
            file.header[trace] = {189: inline, 21: crossline, 109: 200, 117: 4000}
            # Duplicate coordinates deliberately have different samples.
            file.trace[trace] = (trace * 100 + np.arange(4, dtype=np.float32)) if values is None else values[trace]
        file.bin[segyio.BinField.Interval] = 4000
    return Survey(path, geometry_mode="regular" if regular else "auto")


@pytest.fixture(params=["dense", "sparse", "regular_inline", "regular_crossline"])
def native_survey(request, tmp_path):
    if request.param == "dense":
        pairs = [(10, 38), (10, 30), (12, 33), (10, 30), (12, 38)]
    elif request.param == "sparse":
        pairs = [(10, 38), (10, 30), (10, 30), (10, 33)]
        pairs += [(number, number) for number in range(40) if number != 10]
    elif request.param == "regular_inline":
        pairs = [(inline, crossline) for inline in [12, 10] for crossline in [38, 34, 30]]
    else:
        pairs = [(inline, crossline) for crossline in [38, 34, 30] for inline in [12, 10]]
    survey = make_survey(tmp_path / f"{request.param}.segy", pairs, regular=request.param.startswith("regular"))
    if request.param == "sparse":
        assert survey.trace_lookup is None
    return survey


@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("kind", ["inline", "crossline", "time"])
def test_reads_match_existing_native_slices_with_arbitrary_selection(native_survey, monkeypatch, fallback, kind):
    survey = native_survey
    position = 10 if kind == "inline" else 30 if kind == "crossline" else 205
    if kind == "time":
        actual, expected = timeslice(survey, position)
        x, time = survey.crosslines, survey.inlines
    else:
        x, time, expected = survey.section(kind, position)
        actual = position
    survey.cache.clear()
    if fallback:
        monkeypatch.setattr(preview, "SAMPLE_BYTES", {})
    # Neither construction nor any window may fall back to a full native read.
    monkeypatch.setattr(survey, "section", lambda *args: pytest.fail("full section read"))
    source = SliceSource(survey, kind, position)
    assert source.shape == expected.shape
    assert source.dtype == np.dtype(np.float32)
    assert source.position == actual
    assert source.cache_id == (kind, actual)
    assert source.time_sinc is (kind != "time")
    np.testing.assert_array_equal(source.x, x)
    np.testing.assert_array_equal(source.time, time)
    np.testing.assert_array_equal(source.read(slice(None), slice(None)), expected)
    rows = [len(time) - 1, 0, 0]
    columns = [len(x) - 1, 0, len(x) - 1]
    np.testing.assert_array_equal(source.read(rows, columns), expected[np.ix_(rows, columns)])
    assert not survey.cache, "windowed reads must not populate full-slice cache"


def test_sparse_vertical_duplicates_remain_distinct_but_time_grid_keeps_last_trace(tmp_path):
    pairs = [(10, 38), (10, 30), (10, 30), (10, 33)]
    pairs += [(number, number) for number in range(40) if number != 10]
    survey = make_survey(tmp_path / "duplicates.segy", pairs)
    assert survey.trace_lookup is None
    x, ids = survey.section_indices("inline", 10)
    # Match the original argsort rather than changing duplicate tie order.
    expected_ids = survey.maps["inline"][10]
    expected_ids = expected_ids[np.argsort(survey.xls[expected_ids])]
    np.testing.assert_array_equal(ids, expected_ids)
    assert list(x).count(30) == 2
    source = SliceSource(survey, "inline", 10)
    np.testing.assert_array_equal(source.read([0], np.flatnonzero(x == 30)), [[100, 200]])
    time_source = SliceSource(survey, "time", 200)
    row = int(np.flatnonzero(time_source.time == 10)[0])
    column = int(np.flatnonzero(time_source.x == 30)[0])
    assert time_source.read([row], [column])[0, 0] == 200
    assert preview.trace_ids_at(survey, [10], [30])[0] == 1, "sparse point lookup has a different duplicate policy"


def test_vertical_nonfinite_values_match_nan_to_num_while_time_plane_preserves_them(cube):
    with segyio.open(str(cube.path), "r+", ignore_geometry=True) as file:
        file.trace[0] = np.array([np.nan, np.inf, -np.inf, 8], dtype=np.float32)
    x, time, expected = cube.section("inline", 10)
    values = SliceSource(cube, "inline", 10).read(np.arange(len(time)), np.arange(len(x)))
    np.testing.assert_array_equal(values, expected)
    np.testing.assert_array_equal(values[:, 0], [0, np.finfo(np.float32).max, -np.finfo(np.float32).max, 8])
    for position, expected_value in [(200, np.nan), (204, np.inf), (208, -np.inf)]:
        value = SliceSource(cube, "time", position).read([0], [0])[0, 0]
        np.testing.assert_array_equal(value, expected_value)


@pytest.mark.parametrize("kind,position", [("inline", 10), ("crossline", 30), ("time", 204)])
def test_read_tiles_bound_decoder_intermediates_and_iterators_are_repeatable(cube, monkeypatch, kind, position):
    source = SliceSource(cube, kind, position)
    expected = source.read(slice(None), slice(None))
    calls = []
    original = preview.read_samples

    def bounded(survey, trace_ids, samples, **kwargs):
        cells = np.asarray(trace_ids).size * len(samples)
        calls.append(cells)
        assert cells <= 3
        return original(survey, trace_ids, samples, **kwargs)

    monkeypatch.setattr(slice_source, "READ_BLOCK_ELEMENTS", 3)
    monkeypatch.setattr(preview, "read_samples", bounded)
    np.testing.assert_array_equal(source.read(slice(None), slice(None)), expected)
    assert len(calls) > 1
    for _ in range(2):
        blocks = list(source.iter_blocks(max_elements=2))
        assert all(block.dtype == np.float32 and 0 < block.size <= 2 for block in blocks)
        actual = np.concatenate([block.reshape(-1) for block in blocks])
        assert len(actual) == expected.size
        np.testing.assert_array_equal(np.sort(actual), np.sort(expected.reshape(-1)))


def test_selection_validation_empty_axes_negative_indices_and_time_ties(cube):
    source = SliceSource(cube, "inline", 10)
    assert source.read([], [0]).shape == (0, 1)
    assert source.read([0], []).shape == (1, 0)
    assert source.read([], []).shape == (0, 0)
    expected = cube.section("inline", 10)[2]
    np.testing.assert_array_equal(source.read([-1], [-1]), expected[-1:, -1:])
    np.testing.assert_array_equal(source.read(slice(None, None, -1), slice(None, None, -1)), expected[::-1, ::-1])
    for kind, position in [("unknown", 10), ("inline", 11), ("inline", 10.5), ("crossline", np.nan), ("time", 199), ("time", np.inf)]:
        with pytest.raises(ValueError):
            SliceSource(cube, kind, position)
    assert SliceSource(cube, "time", 202).position == 200
    with pytest.raises(IndexError):
        source.read([source.shape[0]], [0])
    with pytest.raises(ValueError):
        source.read([0.5], [0])
    with pytest.raises(ValueError):
        list(source.iter_blocks(0))


@pytest.mark.parametrize("kind,payload", [
    ("inline", {"position": 11.6, "crossline": 34, "time": 205.9}),
    ("crossline", {"position": 34, "inline": 11.6, "time": 205.9}),
])
def test_vertical_probe_reads_exactly_one_sample_with_same_snapping(cube, monkeypatch, kind, payload):
    import backend.main as server
    server.survey = cube
    calls = []
    original = preview.read_samples

    def one_sample(survey, trace_ids, samples, **kwargs):
        calls.append((list(trace_ids), list(samples)))
        assert len(trace_ids) == len(samples) == 1
        return original(survey, trace_ids, samples, **kwargs)

    monkeypatch.setattr(cube, "section", lambda *args: pytest.fail("probe materialized section"))
    monkeypatch.setattr(server, "read_samples", one_sample)
    result = TestClient(server.app).post("/api/sample", json={"kind": kind, **payload})
    assert result.status_code == 200
    data = result.json()
    assert (data["inline"], data["crossline"], data["time"], data["amplitude"]) == (12, 33, 204, 1234)
    assert data["source"] == "original"
    assert len(calls) == 1


def test_vertical_probe_preserves_nan_replacement_and_sparse_duplicate_selection(tmp_path, monkeypatch):
    import backend.main as server
    pairs = [(10, 38), (10, 30), (10, 30), (10, 33)]
    pairs += [(number, number) for number in range(40) if number != 10]
    survey = make_survey(tmp_path / "probe.segy", pairs)
    with segyio.open(str(survey.path), "r+", ignore_geometry=True) as file:
        file.trace[1] = np.array([np.nan, np.inf, -np.inf, 17], dtype=np.float32)
    server.survey = survey
    monkeypatch.setattr(survey, "section", lambda *args: pytest.fail("probe materialized section"))
    client = TestClient(server.app)
    for time, value in [(200, 0), (204, float(np.finfo(np.float32).max)), (208, -float(np.finfo(np.float32).max)), (212, 17)]:
        result = client.post("/api/sample", json={"kind": "inline", "position": 10, "crossline": 30, "time": time})
        assert result.status_code == 200
        assert result.json()["amplitude"] == value


def test_amplitude_iterator_skips_only_geometry_holes_and_reads_each_effective_node_once(native_survey, monkeypatch):
    survey = native_survey
    with segyio.open(str(survey.path), "r+", ignore_geometry=True) as file:
        for trace, value in [(0, np.nan), (len(file.trace) - 1, np.inf)]:
            samples = file.trace[trace].copy()
            samples[1] = value
            file.trace[trace] = samples
    _, expected = timeslice(survey, 204)
    source = SliceSource(survey, "time", 204)
    if survey.regular is not None:
        node_count = survey.count
    else:
        node_count = len(set(zip(survey.ils.tolist(), survey.xls.tolist())))
    calls = []
    original = preview.read_samples

    def record(survey, ids, samples, **kwargs):
        assert 0 < len(ids) <= 2
        assert (np.asarray(ids) >= 0).all()
        calls.extend(np.asarray(ids).reshape(-1).tolist())
        return original(survey, ids, samples, **kwargs)

    monkeypatch.setattr(preview, "read_samples", record)
    monkeypatch.setattr(source, "read", lambda *args: pytest.fail("statistics traversed a Cartesian grid"))
    for _ in range(2):
        calls.clear()
        blocks = list(source.iter_amplitude_blocks(max_elements=2))
        assert all(0 < block.size <= 2 for block in blocks)
        values = np.concatenate(blocks)
        assert len(values) == len(calls) == len(set(calls)) == node_count
        np.testing.assert_array_equal(np.sort(values[np.isfinite(values)]), np.sort(expected[np.isfinite(expected)]))
        assert np.isposinf(values).sum() == np.isposinf(expected).sum()
        if survey.trace_lookup is None and survey.regular is None:
            assert node_count < expected.size // 10, "sparse statistics must avoid empty grid cells"
            assert 1 not in calls and 2 in calls, "duplicate coordinate must keep the last trace"


@pytest.mark.parametrize("kind,position", [("inline", 10), ("crossline", 30)])
def test_vertical_amplitude_iterator_reuses_full_native_distribution(cube, kind, position):
    source = SliceSource(cube, kind, position)
    expected = list(source.iter_blocks(3))
    actual = list(source.iter_amplitude_blocks(3))
    assert len(actual) == len(expected)
    for block, native in zip(actual, expected):
        assert block.size <= 3
        np.testing.assert_array_equal(block, native)
    with pytest.raises(ValueError):
        list(source.iter_amplitude_blocks(0))


@pytest.mark.parametrize("sample_format,dtype,base", [
    (6, np.float64, [2.12345678912345, -3.23456789123456, 1e100, -1e100]),
    (2, np.int32, [16777217, 16777219, 2147483646, -2147483647]),
    (9, np.int64, [2**53 + 3, 2**53 + 5, 2**62 + 37, -(2**62) + 19]),
])
@pytest.mark.parametrize("fallback", [False, True])
def test_regular_time_sources_preserve_native_double_and_integer_precision(tmp_path, monkeypatch, sample_format, dtype, base, fallback):
    pairs = [(inline, crossline) for inline in [12, 10] for crossline in [38, 34, 30]]
    values = np.repeat(np.asarray(base, dtype=dtype)[None, :], len(pairs), axis=0)
    # All sample columns deliberately distinguish exact values from float32.
    survey = make_survey(tmp_path / f"format-{sample_format}.segy", pairs,
                         regular=True, sample_format=sample_format, values=values)
    if fallback:
        monkeypatch.setattr(preview, "SAMPLE_BYTES", {})
    for time in survey.times:
        actual, expected = timeslice(survey, time)
        source = SliceSource(survey, "time", time)
        assert source.dtype == expected.dtype == np.dtype(dtype)
        read = source.read(slice(None), slice(None))
        assert read.tobytes() == expected.tobytes()
        blocks = np.concatenate(list(source.iter_amplitude_blocks(max_elements=2)))
        assert blocks.dtype == expected.dtype
        np.testing.assert_array_equal(np.sort(blocks), np.sort(expected.reshape(-1)))
    # Vertical/auto geometry semantics remain float32 even for these formats.
    with np.errstate(over="ignore"):
        vertical = SliceSource(survey, "inline", 10)
        expected_vertical = survey.section("inline", 10)[2]
        assert vertical.dtype == np.dtype(np.float32)
        np.testing.assert_array_equal(vertical.read(slice(None), slice(None)), expected_vertical)
        auto = Survey(survey.path)
        source = SliceSource(auto, "time", 200)
        assert source.dtype == np.dtype(np.float32)
        np.testing.assert_array_equal(source.read(slice(None), slice(None)), timeslice(auto, 200)[1])


def test_optional_native_dtype_reader_keeps_default_float32_and_rejects_integer_missing_trace(cube):
    assert preview.read_samples(cube, [0], [0]).dtype == np.float32
    assert preview.read_samples(cube, [0], [0], dtype=np.float64).dtype == np.float64
    with pytest.raises(ValueError, match="missing traces"):
        preview.read_samples(cube, [-1], [0], dtype=np.int64)


@pytest.mark.parametrize("limit", [513, 10_000])
def test_sparse_statistics_batches_trace_ids_across_many_short_inlines(monkeypatch, limit):
    from types import SimpleNamespace
    count = 8192
    survey = SimpleNamespace(
        regular=None, trace_lookup=None, count=count,
        times=np.array([200., 204., 208.]),
        inlines=np.arange(count), crosslines=np.arange(count),
        xls=np.arange(count),
        maps={"inline": {inline: np.array([inline]) for inline in range(count)}},
    )
    calls = []

    def selected_samples(survey, ids, samples, *, dtype=np.float32):
        ids = np.asarray(ids)
        assert ids.ndim == 1 and len(ids) <= limit
        calls.append(ids.copy())
        return (ids[:, None] * 100 + np.asarray(samples)[None, :]).astype(dtype)

    monkeypatch.setattr(preview, "read_samples", selected_samples)
    source = SliceSource(survey, "time", 204)
    blocks = list(source.iter_amplitude_blocks(max_elements=limit))
    assert source.shape == (8192, 8192)
    assert len(calls) == (count + limit - 1) // limit
    assert all(block.size <= limit for block in blocks)
    np.testing.assert_array_equal(np.concatenate(calls), np.arange(count))
    np.testing.assert_array_equal(np.concatenate(blocks), np.arange(count, dtype=np.float32) * 100 + 1)
