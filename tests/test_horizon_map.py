import numpy as np
import pytest
from backend.core import Horizon
from backend.horizon_map import HorizonMapState, map_data, render_map
from backend.models import Settings
from test_scene import make_horizon


def test_map_native_coordinates_holes_and_contours(tmp_path):
    h = make_horizon(tmp_path, True)
    state = HorizonMapState(horizon='h', interval=1)
    data = map_data(h, state)
    assert data['x'] == list(range(5)) and data['y'] == list(range(5))
    assert data['z'][1][1] is None
    assert data['z'][2][4] == 208
    assert data['twt_range'] == [200, 212]
    assert data['vmin'] == 200 and data['vmax'] == 212
    assert data['contours']
    for path in data['contours']:
        assert not any(0 < x < 2 and 0 < y < 2 for x, y in zip(path['x'], path['y']))


def test_map_manual_range_reverse_and_constant(tmp_path):
    h = make_horizon(tmp_path)
    state = HorizonMapState(horizon='h', range_mode='manual', vmin=204, vmax=208, reverse_colormap=True)
    data = map_data(h, state)
    assert [data['vmin'], data['vmax']] == [204, 208]
    assert data['colorscale'][0][1] == '#ff00ff'
    assert data['colorscale'][-1][1] == '#ff0000'
    with pytest.raises(ValueError):
        HorizonMapState(horizon='h', range_mode='manual', vmin=2, vmax=1)
    with pytest.raises(ValueError):
        map_data(h, HorizonMapState(horizon='h', interval=.001))
    p = tmp_path / 'constant.txt'
    p.write_text('10 30 500\n10 31 500\n11 30 500\n11 31 500')
    flat = map_data(Horizon(p), HorizonMapState(horizon='h'))
    assert flat['vmin'] < 500 < flat['vmax'] and flat['contours'] == []


@pytest.mark.parametrize('fmt,signature', [('png', b'\x89PNG'), ('pdf', b'%PDF'), ('svg', b'<?xml')])
def test_map_publication_export(tmp_path, fmt, signature):
    h = make_horizon(tmp_path, True)
    content = render_map(h, HorizonMapState(horizon='h', interval=2, labels=True, x_range=(1, 4), y_range=(0, 3)), Settings(format=fmt, width=100, height=100))
    assert content.startswith(signature)


@pytest.mark.parametrize('mode', ['filled', 'contour', 'filled_contour'])
def test_map_modes_and_colormaps(tmp_path, mode):
    h = make_horizon(tmp_path)
    for name in ['petrel', 'turbo', 'viridis', 'cividis', 'jet']:
        data = map_data(h, HorizonMapState(horizon='h', display=mode, colormap=name, interval=2))
        assert len(data['colorscale']) == 256
        assert bool(data['contours']) == (mode != 'filled')


@pytest.mark.parametrize('show_axes', [False, True])
def test_export_axes_visibility(tmp_path, monkeypatch, show_axes):
    from matplotlib.figure import Figure
    figures = []
    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig
    monkeypatch.setattr('backend.horizon_map.Figure', capture)
    render_map(make_horizon(tmp_path), HorizonMapState(horizon='h'), Settings(show_axes=show_axes))
    assert figures[0].axes[0].axison == show_axes
    assert figures[0].axes[1].axison  # Colorbar remains independently visible.
