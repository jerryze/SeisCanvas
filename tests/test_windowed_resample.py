"""Lazy raster reconstruction preserves every ndarray arithmetic operation."""
import numpy as np
import pytest

from backend import resample


class RecordingSource:
    def __init__(self, values):
        self.values = values
        self.shape, self.dtype = values.shape, values.dtype
        self.reads = []

    def __array__(self, *args, **kwargs):
        raise AssertionError("A lazy source must never materialize its full array")

    def read(self, rows, columns):
        rows, columns = np.asarray(rows), np.asarray(columns)
        assert rows.ndim == columns.ndim == 1
        assert len(rows) * len(columns) <= resample.WINDOW_READ_ELEMENTS
        assert np.all((rows >= 0) & (rows < self.shape[0]))
        assert np.all((columns >= 0) & (columns < self.shape[1]))
        self.reads.append((rows.copy(), columns.copy()))
        return self.values[np.ix_(rows, columns)]


def exact_raster(x, time, values, width, height, extent=None, *, time_sinc=True):
    source = RecordingSource(values)
    original = values.tobytes()
    with np.errstate(invalid="ignore"):
        expected = resample.seismic_raster(x, time, values, width, height, extent, time_sinc=time_sinc)
        actual = resample.seismic_raster(x, time, source, width, height, extent, time_sinc=time_sinc)
    assert actual[0].dtype == expected[0].dtype
    assert actual[0].tobytes() == expected[0].tobytes(), "lazy arithmetic changed native rounding or NaN bits"
    for received, reference in zip(actual[1:3], expected[1:3]):
        np.testing.assert_array_equal(received, reference)
    assert actual[3] == expected[3]
    assert values.tobytes() == original
    return source, actual


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("time_sinc", [True, False])
@pytest.mark.parametrize("size", [(1, 1), (7, 11), (73, 121), (517, 259)])
def test_arbitrary_pixel_grids_and_sparse_coordinates_are_bitwise_equal(dtype, time_sinc, size):
    rng = np.random.default_rng(1234)
    x = np.array([10, 12, 30, 31, 95, 200, 212, 300], dtype=float)
    time = np.arange(17) * 4.0 + 200
    if not time_sinc:
        time = np.array([0, 1, 3, 5, 10, 11, 19, 20, 30, 31, 35, 50, 80, 81, 84, 90, 100], dtype=float)
    values = rng.standard_normal((len(time), len(x))).astype(dtype)
    values[0, 0] = -0.0
    values[5, 1], values[12, 3], values[16, 7] = np.nan, np.inf, -np.inf
    exact_raster(x, time, values, *size, time_sinc=time_sinc)
    exact_raster(x, time, values, *size,
                 (11.25, 29.75, time[7] + .35, time[9] - .1), time_sinc=time_sinc)


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("time_sinc", [True, False])
def test_native_knots_zero_weights_and_nonfinite_payloads_match_original(dtype, time_sinc):
    x, time = np.arange(9.0), np.arange(12.0)
    values = np.random.default_rng(15).standard_normal((12, 9)).astype(dtype)
    values[2, 2] = -0.0
    values[3, 3] = np.nan
    values[7, 5] = np.inf
    values[8, 5] = -np.inf
    # A nondefault quiet NaN payload must follow the same math as ndarray.
    bits = values.view(np.uint32 if dtype == np.float32 else np.uint64)
    bits[4, 4] = 0x7fc00057 if dtype == np.float32 else 0x7ff8000000000057
    exact_raster(x, time, values, len(x), len(time), time_sinc=time_sinc)
    # Spatial and temporal zero-weight neighbours contain NaN and Inf.
    values[:, 1] = np.nan
    values[2, :] = np.inf
    source, actual = exact_raster(x, time, values, 1, 1, (-.5, .5, 2.5, 3.5), time_sinc=time_sinc)
    assert np.isfinite(actual[0][0, 0])
    assert source.reads


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("extent", [(-10, 10, -20, 3), (2, 6, 27, 60), (2.2, 2.8, 8, 10)])
def test_boundary_extension_and_original_eight_sample_halo(dtype, extent):
    values = np.zeros((32, 8), dtype=dtype)
    values[7, :] = 1
    source, (_, _, gt, _) = exact_raster(np.arange(8.0), np.arange(32.0), values, 17, 19, extent)
    rows = np.concatenate([rows for rows, _ in source.reads])
    positions = np.clip(gt, 0, 31)
    expected = np.unique(np.concatenate([np.clip(np.floor(positions).astype(int) + tap - 3, 0, 31) for tap in range(8)]))
    np.testing.assert_array_equal(np.unique(rows), expected)
    if extent[2:] == (8, 10):
        assert 7 in rows, "outside-visible sample must contribute through the sinc halo"


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("shape", [(1, 1), (1, 5), (2, 1), (2, 2), (3, 4)])
@pytest.mark.parametrize("time_sinc", [True, False])
def test_singleton_short_axes_and_tiny_viewports(dtype, shape, time_sinc):
    values = np.arange(np.prod(shape), dtype=dtype).reshape(shape)
    values[-1, -1] = np.nan
    exact_raster(np.arange(shape[1], dtype=float), np.arange(shape[0], dtype=float), values,
                 23, 17, time_sinc=time_sinc)


@pytest.mark.parametrize("time_sinc", [True, False])
def test_forced_small_tiles_do_not_change_rounding_or_read_full_columns(monkeypatch, time_sinc):
    monkeypatch.setattr(resample, "WINDOW_READ_ELEMENTS", 128)
    x, time = np.arange(211.0), np.arange(103.0)
    values = np.random.default_rng(19).normal(size=(103, 211)).astype(np.float32)
    source, _ = exact_raster(x, time, values, 517, 319, (12.2, 193.4, 16.35, 89.85), time_sinc=time_sinc)
    assert len(source.reads) > 20
    assert max(len(rows) * len(columns) for rows, columns in source.reads) <= 128
    assert max(len(rows) for rows, _ in source.reads) < len(time)


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
@pytest.mark.parametrize("time_sinc", [True, False])
def test_downsampling_reads_disjoint_needed_rows_not_entire_spans(dtype, time_sinc):
    x, time = np.arange(51.0), np.arange(1201.0)
    values = np.random.default_rng(33).normal(size=(1201, 51)).astype(dtype)
    source, _ = exact_raster(x, time, values, 9, 11, time_sinc=time_sinc)
    rows = np.unique(np.concatenate([rows for rows, _ in source.reads]))
    assert len(rows) <= (8 if time_sinc else 2) * 11
    assert len(rows) < len(time) // 10


class LogicalSource:
    """Large logical grid whose values exist only at requested coordinates."""
    def __init__(self, shape):
        self.shape = shape
        self.dtype = np.dtype(np.float32)
        self.reads = []

    def __array__(self, *args, **kwargs):
        raise AssertionError("Cannot materialize the large logical grid")

    def read(self, rows, columns):
        assert len(rows) * len(columns) <= resample.WINDOW_READ_ELEMENTS
        self.reads.append((np.array(rows), np.array(columns)))
        return (np.sin(np.asarray(rows)[:, None] * .1) + np.asarray(columns)[None, :] * .01).astype(np.float32)


@pytest.mark.parametrize("time_sinc", [True, False])
def test_large_logical_grid_reads_only_small_viewport_stencil(time_sinc):
    source = LogicalSource((200_000, 100_000))
    x, time = np.arange(source.shape[1], dtype=float), np.arange(source.shape[0], dtype=float)
    extent = (90_000.1, 90_002.9, 100_000.2, 100_002.8)
    actual = resample.seismic_raster(x, time, source, 37, 41, extent, time_sinc=time_sinc)
    rows = np.unique(np.concatenate([r for r, _ in source.reads]))
    columns = np.unique(np.concatenate([c for _, c in source.reads]))
    assert rows.min() >= 99_997 and rows.max() <= 100_006
    assert columns.min() >= 90_000 and columns.max() <= 90_003
    assert sum(len(r) * len(c) for r, c in source.reads) < 100
    assert actual[0].shape == (41, 37)
    # Compare to an independently materialized local source with full halo.
    local_rows, local_columns = np.arange(99_990, 100_015), np.arange(89_990, 90_015)
    values = (np.sin(local_rows[:, None] * .1) + local_columns[None, :] * .01).astype(np.float32)
    reference = resample.seismic_raster(local_columns, local_rows, values, 37, 41, extent, time_sinc=time_sinc)
    assert actual[0].tobytes() == reference[0].tobytes()


def test_invalid_lazy_dimensions_and_coordinates_fail_before_amplitude_reads():
    source = RecordingSource(np.zeros((3, 2), dtype=np.float32))
    for x, time, width, height in [([0, 1], [0, 1], 2, 2), ([1, 0], [0, 1, 2], 2, 2),
                                   ([0, 1], [0, 1, 3], 2, 2), ([0, 1], [0, 1, 2], 0, 2),
                                   ([0, 1], [0, 1, 2], 8001, 1), ([0, 1], [0, 1, 2], 8000, 8000)]:
        with pytest.raises(ValueError):
            resample.seismic_raster(x, time, source, width, height)
    assert not source.reads
