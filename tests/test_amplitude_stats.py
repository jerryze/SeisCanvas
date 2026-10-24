"""Exact pooled colour limits, including forced bounded-memory selection."""
import numpy as np
import pytest

from backend import amplitude_stats
from backend.amplitude_stats import amplitude_limits
from backend.models import Seismic
from backend.rendering import amplitude


class Blocks:
    def __init__(self, data):
        self.data = data
        self.dtype = data.dtype
        self.shape = data.shape
        self.requests = []
        self.yielded_sizes = []
        self.passes = 0

    def iter_blocks(self, *, max_elements):
        self.requests.append(max_elements)
        self.passes += 1
        for start in range(0, self.data.size, max_elements):
            block = self.data.flat[start:start + max_elements].reshape(1, -1)
            self.yielded_sizes.append(block.size)
            yield block


def reference(arrays, seismic):
    joined = np.concatenate([array.ravel() for array in arrays]) if arrays else np.empty(0)
    with np.errstate(over="ignore", invalid="ignore"):
        return amplitude(joined, seismic)[1:]


def exact(arrays, seismic):
    with np.errstate(over="ignore", invalid="ignore"):
        actual = amplitude_limits(arrays, seismic)
    np.testing.assert_equal(actual, reference(arrays, seismic))


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("symmetric,reverse", [(False, False), (False, True), (True, False), (True, True)])
@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64])
def test_random_arrays_match_exact_numpy_percentiles(monkeypatch, streaming, symmetric, reverse, dtype):
    if streaming:
        monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 32)
        monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 113)
    random = np.random.default_rng(781)
    arrays = [random.normal(size=(31, 17)).astype(dtype), random.normal(size=(13, 19)).astype(dtype)]
    arrays[0].flat[::41] = np.nan
    arrays[0].flat[::71] = np.inf
    arrays[1].flat[::53] = -np.inf
    for percentile in (0.1, 33.33333333333333, 99.5, 100):
        exact(arrays, Seismic(symmetric=symmetric, reverse_polarity=reverse, clip_percentile=percentile))


@pytest.mark.parametrize("symmetric", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
def test_lazy_mixed_dtype_is_promoted_before_polarity_and_abs(monkeypatch, symmetric, reverse):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 7)
    arrays = [np.array([-128, -100, -1, 0, 20, 127], dtype=np.int8),
              np.array([-1e20, 1e20, 0.001, np.nan], dtype=np.float32),
              np.array([0.12345678912345, -0.98765432198765], dtype=np.float64)]
    sources = [Blocks(array) for array in arrays]
    seismic = Seismic(symmetric=symmetric, reverse_polarity=reverse, clip_percentile=65.3)
    np.testing.assert_equal(amplitude_limits(sources, seismic), reference(arrays, seismic))
    assert all(source.passes == 4 for source in sources)
    assert all(max(source.yielded_sizes) <= 7 and set(source.requests) == {7} for source in sources)


@pytest.mark.parametrize("dtype", [np.float16, np.float32, np.float64, np.int8, np.int64, np.uint8, np.uint64])
def test_extremes_duplicates_and_input_dtype_interpolation(monkeypatch, dtype):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 1)
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 3)
    info = np.finfo(dtype) if np.dtype(dtype).kind == "f" else np.iinfo(dtype)
    if np.dtype(dtype).kind == "f":
        smallest = np.nextafter(dtype(0), dtype(1))
        arrays = [np.array([-info.max, -info.max, -smallest, -0.0, 0, smallest, info.max, info.max], dtype=dtype)]
    else:
        arrays = [np.array([info.min, info.min, 0, 0, 1, info.max, info.max], dtype=dtype)]
    for symmetric in (False, True):
        for reverse in (False, True):
            for percentile in (1, 50, 99.5, 100):
                exact(arrays, Seismic(symmetric=symmetric, reverse_polarity=reverse, clip_percentile=percentile))


@pytest.mark.parametrize("arrays", [[], [np.empty((0, 3), dtype=np.float32)],
                                    [np.array([[np.nan, np.inf, -np.inf]])],
                                    [np.zeros(50, dtype=np.float32)], [np.full(50, -7.25)]])
@pytest.mark.parametrize("symmetric", [False, True])
def test_empty_nonfinite_constant_and_zero_data(monkeypatch, arrays, symmetric):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    exact(arrays, Seismic(symmetric=symmetric))


def test_strided_arrays_and_big_endian_inputs_do_not_mutate(monkeypatch):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 19)
    original = np.random.default_rng(42).normal(size=(71, 43)).astype(">f8")
    before = original.copy()
    arrays = [original.T[::-2, 1::3], np.array([], dtype="f4")]
    exact(arrays, Seismic(symmetric=False, reverse_polarity=True, clip_percentile=83.2))
    np.testing.assert_array_equal(original, before)
    assert max(chunk.size for chunk in amplitude_stats._chunks(arrays)) <= 19


def test_default_lazy_blocks_never_exceed_limit_and_statistics_are_exact(monkeypatch):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 16)
    data = np.random.default_rng(9).normal(size=(801, 700)).astype(np.float64)
    source = Blocks(data)
    seismic = Seismic(symmetric=False, clip_percentile=99.7)
    np.testing.assert_equal(amplitude_limits(source, seismic), reference([data], seismic))
    assert source.passes == 4
    assert max(source.requests) <= 262144
    assert max(source.yielded_sizes) <= 262144


def test_small_lazy_data_uses_one_read_pass():
    data = np.arange(100, dtype=np.float32).reshape(10, 10)
    source = Blocks(data)
    np.testing.assert_equal(amplitude_limits([source], Seismic()), reference([data], Seismic()))
    assert source.passes == 1


@pytest.mark.parametrize("other", [np.empty(0, dtype=np.float64), np.array([np.nan, np.inf])])
def test_empty_and_nonfinite_sources_still_participate_in_requested_promotion(monkeypatch, other):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    arrays = [np.array([-3.25, -1e-20, 0.12345679, 7.1], dtype=np.float32), other]
    exact(arrays, Seismic(symmetric=False, clip_percentile=67.3))
    # This is the helper's concatenate contract. Scene callers that used to
    # omit empty finite sets must omit the corresponding source explicitly.
    assert np.result_type(*(array.dtype for array in arrays)) == np.float64


def test_generated_large_source_has_bounded_working_allocations():
    import tracemalloc

    class Generated:
        dtype = np.dtype("float64")
        shape = (1000, 1000)

        def iter_blocks(self, *, max_elements):
            for offset in range(0, 1_000_000, max_elements):
                yield np.arange(offset, min(1_000_000, offset + max_elements), dtype=self.dtype).reshape(1, -1)

    tracemalloc.start()
    try:
        actual = amplitude_limits(Generated(), Seismic(symmetric=False))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Includes freshly generated source blocks and NumPy's internal temporary
    # allocations; no million-element input array is retained by the fixture.
    assert peak < 8 * 1024 * 1024
    expected = reference([np.arange(1_000_000, dtype=np.float64)], Seismic(symmetric=False))
    np.testing.assert_equal(actual, expected)


def test_four_simultaneous_radix_prefixes_fit_memory_budget():
    import tracemalloc

    class FourBuckets:
        dtype = np.dtype("float64")
        shape = (1_048_576, 1)

        def iter_blocks(self, *, max_elements):
            for value in (-10.0, -1.0, 1.0, 10.0):
                for offset in range(0, 262144, max_elements):
                    yield np.full((1, min(max_elements, 262144 - offset)), value, dtype=self.dtype)

    # Both adjacent order statistics for EACH of two quantiles fall into
    # different high-bit prefixes: the worst-case four 65536-bin histograms.
    tracemalloc.start()
    try:
        actual = amplitude_limits(FourBuckets(), Seismic(symmetric=False, clip_percentile=50))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 8 * 1024 * 1024
    assert actual == (-3.25, 3.25)


def test_manual_limits_do_not_read_or_inspect_sources():
    class Unreadable:
        @property
        def dtype(self):
            raise AssertionError("Manual limits do not need source samples")

    assert amplitude_limits([Unreadable()], Seismic(clip_mode="manual", vmin=-2, vmax=7)) == (-2, 7)
    for lo, hi in ((None, 1), (0, None), (1, 1), (2, 1)):
        seismic = Seismic.model_construct(clip_mode="manual", vmin=lo, vmax=hi)
        with pytest.raises(ValueError, match="minimum must be less"):
            amplitude_limits([Unreadable()], seismic)


def test_lazy_source_that_ignores_block_bound_is_rejected(monkeypatch):
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 10)
    class Unbounded:
        dtype = np.dtype("float32")
        shape = (1, 11)

        def iter_blocks(self, *, max_elements):
            yield np.zeros(self.shape, self.dtype)

    with pytest.raises(ValueError, match="block size"):
        amplitude_limits([Unbounded()], Seismic())


def test_optional_statistics_iterator_omits_only_nonfinite_grid_holes(monkeypatch):
    monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 3)
    grid = np.array([[np.nan, -5, np.inf], [2, np.nan, 7], [np.nan, -1, 3]], dtype=np.float32)

    class SparseGrid:
        dtype = grid.dtype
        shape = grid.shape
        passes = 0

        def iter_blocks(self, *, max_elements):
            pytest.fail("Statistics should not walk the mostly empty grid")

        def iter_amplitude_blocks(self, *, max_elements):
            self.passes += 1
            assert max_elements == 3
            # Omit the geometric holes; actual nonfinite values are permitted
            # and are filtered by the normal statistics path.
            values = np.array([-5, np.inf, 2, 7, -1, 3], dtype=self.dtype)
            for start in range(0, len(values), max_elements):
                yield values[start:start + max_elements].reshape(1, -1)

    source = SparseGrid()
    seismic = Seismic(symmetric=False, reverse_polarity=True, clip_percentile=73.25)
    np.testing.assert_equal(amplitude_limits(source, seismic), reference([grid], seismic))
    assert source.passes == 2  # float32 high bits during count + low bits


@pytest.mark.parametrize("streaming", [False, True])
@pytest.mark.parametrize("empty_values", [np.empty(0, dtype=np.float64),
                                        np.array([np.nan, np.inf, -np.inf], dtype=np.float64)])
def test_omit_empty_sources_preserves_finite_only_scene_dtype(monkeypatch, streaming, empty_values):
    if streaming:
        monkeypatch.setattr(amplitude_stats, "SMALL_BUFFER_BYTES", 8)
    values = np.array([-3.25, -1e-20, 0.12345679, 7.1], dtype=np.float32)
    seismic = Seismic(symmetric=False, clip_percentile=67.3)
    source, empty_source = Blocks(values), Blocks(empty_values)
    actual = amplitude_limits([source, empty_source], seismic, omit_empty_sources=True)
    promoted = amplitude_limits([source, empty_source], seismic, omit_empty_sources=False)
    np.testing.assert_equal(actual, reference([values], seismic))
    np.testing.assert_equal(promoted, reference([values, empty_values], seismic))
    assert actual != promoted, "The fixture must detect float32 interpolation changing to float64"


def test_omit_empty_sources_checks_only_until_first_finite_block(monkeypatch):
    monkeypatch.setattr(amplitude_stats, "BLOCK_ELEMENTS", 2)
    class LeadingGap(Blocks):
        def iter_amplitude_blocks(self, *, max_elements):
            yield from self.iter_blocks(max_elements=max_elements)

    source = LeadingGap(np.array([np.nan, np.nan, np.inf, 1, 2, 3], dtype=np.float32))
    seismic = Seismic(symmetric=False)
    result = amplitude_limits([source], seismic, omit_empty_sources=True)
    np.testing.assert_equal(result, reference([source.data], seismic))
    assert source.passes == 2
    # Two blocks establish non-emptiness, then one complete three-block pass.
    assert source.yielded_sizes == [2, 2, 2, 2, 2]


def test_omit_all_nonfinite_sources_keeps_empty_fallback():
    source = Blocks(np.array([np.nan, np.inf, -np.inf], dtype=np.float64))
    assert amplitude_limits([source], Seismic(), omit_empty_sources=True) == (-1, 1)
    assert source.passes == 1
