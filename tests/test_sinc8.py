"""Finite SU sinc reconstruction acts on original amplitudes in world space."""

import numpy as np
import pytest

from backend import resample


def test_su_least_squares_coefficient_fixture_and_cardinal_phases():
    # Independently evaluated with the scalar Levinson recursion documented in
    # CWP stoepd/mksinc (double solve, float coefficients), not NumPy's solver.
    quarter = np.array([
        -0.008847328834, 0.039822049439, -0.132439866662, 0.877203285694,
        0.293185681105, -0.095383614302, 0.033060885966, -0.007847742178,
    ], dtype=np.float32)
    half = np.array([
        -0.011648387648, 0.050596099347, -0.155310764909, 0.615490496159,
        0.615490496159, -0.155310764909, 0.050596099347, -0.011648387648,
    ], dtype=np.float32)
    table = resample._sinc8_table()
    assert table.shape == (513, 8)
    assert not table.flags.writeable
    np.testing.assert_array_equal(table[128].astype(np.float32), quarter)
    np.testing.assert_array_equal(table[256].astype(np.float32), half)
    np.testing.assert_array_equal(table[384].astype(np.float32), quarter[::-1])
    np.testing.assert_array_equal(table[0], [0, 0, 0, 1, 0, 0, 0, 0])
    np.testing.assert_array_equal(table[-1], [0, 0, 0, 0, 1, 0, 0, 0])
    assert resample._sinc8_table() is table


@pytest.mark.parametrize("dtype", [np.float32, np.float64])
def test_original_knots_are_exact_and_input_is_unchanged(dtype):
    values = np.random.default_rng(3).standard_normal((19, 4)).astype(dtype)
    values[2, 0], values[5, 1] = -0.0, np.nan
    original = values.copy()
    result = resample.sinc8(values, np.arange(19))
    assert result.dtype == dtype
    # Compare raw storage to include signed zero and the original NaN payload.
    assert result.tobytes() == original.tobytes()
    assert values.tobytes() == original.tobytes()
    result[0, 0] += 1
    assert values.tobytes() == original.tobytes()


def test_other_axis_and_noncontiguous_source():
    values = np.arange(60, dtype=np.float32).reshape(3, 4, 5)[:, ::2, :]
    result = resample.sinc8(values, [0, 1, 3], axis=-1)
    np.testing.assert_array_equal(result, values[:, :, [0, 1, 3]])
    result = resample.sinc8(values, [0, 1], axis=1)
    np.testing.assert_array_equal(result, values)


def test_bandlimited_sine_reconstruction_is_better_than_linear():
    positions = np.arange(256)
    frequency = 0.2  # 40% of Nyquist, within SU's fitted bandwidth.
    values = np.sin(2 * np.pi * frequency * positions)
    query = np.arange(8.0, 248.0, 0.125)
    expected = np.sin(2 * np.pi * frequency * query)
    sinc_error = np.sqrt(np.mean((resample.sinc8(values, query) - expected) ** 2))
    linear_error = np.sqrt(np.mean((np.interp(query, positions, values) - expected) ** 2))
    assert sinc_error < 0.005
    assert sinc_error < linear_error / 20


def test_eight_tap_impulse_support_and_overshoot_not_preclipped():
    values = np.zeros(41)
    values[20] = 1
    query = np.arange(0, 40.01, 0.25)
    result = resample.sinc8(values, query)
    assert np.all(result[(query <= 16) | (query >= 24)] == 0)
    assert result[query == 20].item() == 1
    assert result.min() < 0  # finite sinc ringing survives until display clip
    step = np.r_[np.zeros(16), np.ones(16)]
    result = resample.sinc8(step, np.arange(8, 24, 0.125))
    assert result.min() < 0 and result.max() > 1


def test_endpoint_extension_empty_singleton_and_short_traces():
    query = [-10, -0.25, 0, 0.5, 1, 1.5, 2, 5, np.nan, np.inf]
    result = resample.sinc8([1.0, 3.0, 2.0], query)
    np.testing.assert_array_equal(result[:3], [1, 1, 1])
    np.testing.assert_array_equal(result[6:8], [2, 2])
    assert np.isfinite(result[:8]).all()
    assert np.isnan(result[8:]).all()
    assert resample.sinc8([], [0, 0.5]).shape == (2,)
    assert np.isnan(resample.sinc8([], [0, 0.5])).all()
    np.testing.assert_array_equal(resample.sinc8([7.0], [-2, 0, 0.5, 3]), [7] * 4)
    assert np.isfinite(resample.sinc8([1.0, 2.0], [0.5])).all()
    assert resample.sinc8([1.0, 2.0], []).shape == (0,)


def test_missing_taps_remain_gaps_but_unused_zero_taps_do_not_poison_knots():
    values = np.arange(20, dtype=float)
    values[10] = np.nan
    result = resample.sinc8(values, [3.5, 7.5, 9, 10, 11])
    assert np.isfinite(result[0])
    assert np.isnan(result[1])
    assert result[2] == 9 and np.isnan(result[3]) and result[4] == 11
    # The nearest tabulated phase is cardinal for a sufficiently small offset.
    assert resample.sinc8(values, [9.0001]).item() == 9


def test_native_grid_has_exact_world_alignment_and_original_amplitudes():
    x = np.array([30, 33, 36])
    time = np.array([200, 204, 208, 212])
    values = np.arange(12, dtype=np.float32).reshape(4, 3)
    raster, gx, gt, extent = resample.seismic_raster(x, time, values, 3, 4)
    np.testing.assert_array_equal(gx, x)
    np.testing.assert_array_equal(gt, time)
    np.testing.assert_array_equal(raster, values)
    assert extent == (28.5, 37.5, 198.0, 214.0)


def test_irregular_trace_coordinates_use_world_linear_then_time_sinc():
    x = np.array([10, 14, 23], dtype=float)
    time = np.arange(200, 228, 4, dtype=float)
    wave = np.array([0, 1, 0, -1, 0, 1, 0], dtype=float)
    factors = np.array([1, 3, -2], dtype=float)
    values = wave[:, None] * factors
    raster, gx, gt, extent = resample.seismic_raster(
        x, time, values, 13, 24, extent=(10, 23, 200, 224)
    )
    expected = np.outer(
        resample.sinc8(wave, (gt - time[0]) / 4),
        np.interp(gx, x, factors),
    )
    np.testing.assert_allclose(raster, expected, atol=1e-12)
    assert extent == (10, 23, 200, 224)
    np.testing.assert_array_equal(gx, np.arange(10.5, 23))


def test_visible_viewport_uses_original_outside_samples_for_sinc_halo():
    x, time = [30.0], np.arange(20, dtype=float)
    values = np.zeros((20, 1))
    values[7, 0] = 1  # outside the requested time interval, inside sinc support
    raster, _, gt, _ = resample.seismic_raster(x, time, values, 1, 4, (29.5, 30.5, 8, 10))
    np.testing.assert_array_equal(gt, [8.25, 8.75, 9.25, 9.75])
    np.testing.assert_array_equal(raster[:, 0], resample.sinc8(values[:, 0], gt))
    assert np.any(raster != 0)


def test_raster_knot_does_not_use_nan_adjacent_trace():
    values = np.array([[1, np.nan], [2, np.nan], [3, np.nan]], dtype=float)
    raster, _, _, _ = resample.seismic_raster([10, 12], [0, 1, 2], values, 1, 3, (9, 11, -0.5, 2.5))
    np.testing.assert_array_equal(raster[:, 0], [1, 2, 3])
    raster, _, _, _ = resample.seismic_raster([10, 12], [0, 1, 2], values, 1, 3, (10, 12, -0.5, 2.5))
    assert np.isnan(raster).all()


def test_large_raster_chunks_match_independently_rendered_adjacent_viewports():
    x, time = np.arange(151.0), np.arange(1200.0)
    values = (np.sin(time[:, None] * 0.3) * np.cos(x[None, :] * 0.1)).astype(np.float32)
    values[80:85, 40] = np.nan
    full, _, _, extent = resample.seismic_raster(x, time, values, 2048, 1024)
    left, right, top, bottom = extent
    pieces = []
    for start in range(0, 2048, 512):
        bounds = (
            left + start * (right - left) / 2048,
            left + (start + 512) * (right - left) / 2048,
            top, bottom,
        )
        pieces.append(resample.seismic_raster(x, time, values, 512, 1024, bounds)[0])
    np.testing.assert_array_equal(full, np.concatenate(pieces, axis=1))


@pytest.mark.parametrize("width,height", [(0, 2), (2, 0), (8001, 1), (8000, 8000)])
def test_raster_resolution_guards(width, height):
    with pytest.raises(ValueError):
        resample.seismic_raster([0, 1], [0, 1], np.zeros((2, 2)), width, height)


def test_invalid_coordinates_source_shape_and_indices_are_rejected():
    with pytest.raises(ValueError):
        resample.seismic_raster([1, 0], [0, 1], np.zeros((2, 2)), 2, 2)
    with pytest.raises(ValueError):
        resample.seismic_raster([0, 1], [0, 1, 3], np.zeros((3, 2)), 2, 2)
    with pytest.raises(ValueError):
        resample.seismic_raster([0, 1], [0, 1], np.zeros((2, 3)), 2, 2)
    with pytest.raises(ValueError):
        resample.sinc8([1, 2], [[0, 1]])
    with pytest.raises(ValueError):
        resample.sinc8([1, 2], [0], axis=1)
