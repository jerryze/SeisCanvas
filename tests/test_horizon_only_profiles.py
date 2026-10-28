"""A–B profiles retain real horizon geometry without inventing amplitudes."""
import numpy as np
import pytest

from backend.horizon import Horizon
from backend.horizon_geometry import HorizonGeometry
from backend.horizon_map import map_profile, render_profile, sample_seismic_line
from backend.models import HorizonMapState, Settings


@pytest.fixture
def horizon_only(tmp_path):
    path = tmp_path / 'layer.txt'
    path.write_text('\n'.join(f'{il} {xl} {200 + 2 * il + xl}' for il in range(5) for xl in range(5)))
    horizons = {'h': Horizon(path)}
    return HorizonGeometry(horizons), horizons


def test_profile_has_only_interpolated_horizon_values(horizon_only, monkeypatch):
    geometry, horizons = horizon_only
    def no_samples(*args, **kwargs):
        pytest.fail('A horizon-only profile must never read seismic samples')
    monkeypatch.setattr('backend.horizon_map.read_samples', no_samples)
    result = map_profile(geometry, horizons['h'], HorizonMapState(horizon='h'), horizons, (1, 1), (3, 3))
    assert result['has_seismic'] is False
    assert result['amplitude'] == []
    assert result['vmin'] is None and result['vmax'] is None
    assert result['trace_overlay'] is None
    assert result['path_start'] == pytest.approx([.7, .7])
    assert result['path_end'] == pytest.approx([3.3, 3.3])
    assert result['time_range'] == [200., 212.]
    values = result['curves'][0]['values']
    expected = 200 + 3 * np.linspace(.7, 3.3, len(values))
    assert values == pytest.approx(expected)
    assert sample_seismic_line(geometry, np.array([1., 2.]), np.array([1., 2.])).shape == (2, 0)


@pytest.mark.parametrize('fmt,signature', [('png', b'\x89PNG'), ('pdf', b'%PDF'), ('svg', b'<?xml')])
def test_horizon_only_profile_exports_without_amplitude_colorbar(horizon_only, fmt, signature, monkeypatch):
    geometry, horizons = horizon_only
    def no_colorbar(*args, **kwargs):
        pytest.fail('A horizon-only profile must not display an amplitude colorbar')
    monkeypatch.setattr('matplotlib.figure.Figure.colorbar', no_colorbar)
    content, info = render_profile(geometry, HorizonMapState(horizon='h', colorbar=True), horizons,
        (1, 1), (3, 3), Settings(format=fmt, long_edge=600), curve_colors={'h': '#ff0000'})
    assert content.startswith(signature)
    assert info['has_seismic'] is False
    assert info['vmin'] is None and info['vmax'] is None
    assert info['curves'] == ['layer']


def test_horizon_only_profile_keeps_missing_horizon_cells_as_gaps(tmp_path):
    path = tmp_path / 'gap.txt'
    path.write_text('\n'.join(f'{il} {xl} {200 + il + xl}' for il in range(5) for xl in range(5) if (il, xl) != (2, 2)))
    horizons = {'h': Horizon(path)}
    result = map_profile(HorizonGeometry(horizons), horizons['h'], HorizonMapState(horizon='h'), horizons, (2, 0), (2, 4))
    assert result['curves'][0]['values'] == [202., 203., None, 205., 206.]


@pytest.mark.parametrize('with_seismic', [False, True])
@pytest.mark.parametrize('endpoint,axis,side', [(0, 1, 'low'), (1, 1, 'high'), (0, 0, 'low'), (1, 0, 'high')])
def test_profile_rejects_outside_endpoints_instead_of_misplacing_labels(horizon_only, cube, with_seismic, endpoint, axis, side):
    geometry, horizons = horizon_only
    if with_seismic:
        geometry, horizons = cube, {}
    a = [float(geometry.inlines[0]), float(geometry.crosslines[0])]
    b = [float(geometry.inlines[-1]), float(geometry.crosslines[-1])]
    bounds = geometry.inlines if axis == 0 else geometry.crosslines
    (a, b)[endpoint][axis] = float(bounds[0] - 1 if side == 'low' else bounds[-1] + 1)
    state = HorizonMapState(horizon='h')
    # The segment crosses the rectangle, so merely clipping its path would
    # produce a plausible but scientifically wrong A/B marker position.
    with pytest.raises(ValueError, match='端点必须位于数据范围内'):
        map_profile(geometry, None, state, horizons, a, b)
    with pytest.raises(ValueError, match='端点必须位于数据范围内'):
        render_profile(geometry, state, horizons, a, b, Settings(long_edge=600))
