import numpy as np
import pytest
from backend.core import Horizon
from backend.horizon_map import HorizonMapState, map_data, render_map
from backend.models import Settings
from conftest import make_horizon


def test_map_native_coordinates_holes_and_contours(tmp_path):
    h = make_horizon(tmp_path, True)
    state = HorizonMapState(horizon='h', interval=1)
    data = map_data(None, h, state)
    assert data['x'] == list(range(5)) and data['y'] == list(range(5))
    assert data['z'][1][1] is None
    assert data['z'][2][4] == 208
    assert data['twt_range'] == [200, 212]
    assert data['vmin'] == 200 and data['vmax'] == 212
    assert data['color_by'] == 'twt' and data['colorbar_title'] == 'TWT (ms)'
    assert data['contours']
    for path in data['contours']:
        assert not any(0 < x < 2 and 0 < y < 2 for x, y in zip(path['x'], path['y']))


def test_map_manual_range_reverse_and_constant(tmp_path):
    h = make_horizon(tmp_path)
    state = HorizonMapState(horizon='h', range_mode='manual', vmin=204, vmax=208, reverse_colormap=True)
    data = map_data(None, h, state)
    assert [data['vmin'], data['vmax']] == [204, 208]
    assert data['colorscale'][0][1] == '#ff00ff'
    assert data['colorscale'][-1][1] == '#ff0000'
    with pytest.raises(ValueError):
        HorizonMapState(horizon='h', range_mode='manual', vmin=2, vmax=1)
    with pytest.raises(ValueError):
        map_data(None, h, HorizonMapState(horizon='h', interval=.001))
    p = tmp_path / 'constant.txt'
    p.write_text('10 30 500\n10 31 500\n11 30 500\n11 31 500')
    flat = map_data(None, Horizon(p), HorizonMapState(horizon='h'))
    assert flat['vmin'] < 500 < flat['vmax'] and flat['contours'] == []


@pytest.mark.parametrize('fmt,signature', [('png', b'\x89PNG'), ('pdf', b'%PDF'), ('svg', b'<?xml')])
def test_map_publication_export(tmp_path, fmt, signature):
    h = make_horizon(tmp_path, True)
    content = render_map(None, h, HorizonMapState(horizon='h', interval=2, labels=True, x_range=(1, 4), y_range=(0, 3)), Settings(format=fmt, width=100, height=100))
    assert content.startswith(signature)


@pytest.mark.parametrize('mode', ['filled', 'contour', 'filled_contour'])
def test_map_modes_and_colormaps(tmp_path, mode):
    h = make_horizon(tmp_path)
    for name in ['petrel', 'turbo', 'viridis', 'cividis', 'jet']:
        data = map_data(None, h, HorizonMapState(horizon='h', display=mode, colormap=name, interval=2))
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
    render_map(None, make_horizon(tmp_path), HorizonMapState(horizon='h'), Settings(show_axes=show_axes))
    assert figures[0].axes[0].axison == show_axes
    assert figures[0].axes[1].axison  # Colorbar remains independently visible.


def test_map_export_uses_the_publication_font(tmp_path, monkeypatch):
    from matplotlib.figure import Figure
    from matplotlib.text import Text
    figures = []
    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig
    monkeypatch.setattr('backend.horizon_map.Figure', capture)
    render_map(None, make_horizon(tmp_path), HorizonMapState(horizon='h'), Settings())
    texts = figures[0].findobj(Text)
    assert texts
    assert all(t.get_fontfamily() == ['Times New Roman', 'DejaVu Serif'] for t in texts)


# ------------------------------------------------------------------ amplitude


def amplitude_horizon(tmp_path, twt, xls=(30, 33)):
    p = tmp_path / 'amp.txt'
    p.write_text(''.join(f'{il} {xl} {twt}\n' for il in (10, 12) for xl in xls))
    return Horizon(p)


def test_amplitude_samples_the_exact_sample(cube, tmp_path):
    h = amplitude_horizon(tmp_path, 204)
    state = HorizonMapState(horizon='h', color_by='amplitude', display='filled')
    data = map_data(cube, h, state)
    assert data['color_by'] == 'amplitude'
    assert data['colorbar_title'] == 'Amplitude'
    assert data['scalar_name'] == 'Amplitude' and data['scalar_unit'] == ''
    # Sample index (204-200)/4 == 1 exactly: amplitude = trace[1] + il*100 + xl.
    assert data['z'] == [[1031, 1034], [1231, 1234]]
    # Auto amplitude range is symmetric around zero (default 99th percentile).
    assert data['vmin'] == pytest.approx(-data['vmax'])
    assert data['vmax'] == pytest.approx(float(np.percentile(np.abs([1031, 1034, 1231, 1234]), 99)))


def test_amplitude_interpolates_fractional_times(cube, tmp_path):
    h = amplitude_horizon(tmp_path, 206)
    state = HorizonMapState(horizon='h', color_by='amplitude')
    data = map_data(cube, h, state)
    # Sample index (206-200)/4 == 1.5: average of trace[1] and trace[2].
    assert data['z'] == [[1031.5, 1034.5], [1231.5, 1234.5]]
    # The horizon TWT extent stays a TWT range even for amplitude maps.
    assert data['twt_range'] == [206, 206]


def test_amplitude_ignores_invalid_cells(cube, tmp_path):
    p = tmp_path / 'mixed.txt'
    p.write_text('10 30 100\n10 33 204\n12 30 2000\n12 33 206\n')
    h = Horizon(p)
    data = map_data(cube, h, HorizonMapState(horizon='h', color_by='amplitude', display='filled'))
    # Times outside the survey range stay invalid instead of clipping to the edge.
    assert data['z'] == [[None, 1034], [None, pytest.approx(1234.5)]]


def test_amplitude_requires_survey_grid_cells(cube, tmp_path):
    # xl=31 is not one of the survey crosslines (30/33/38): no trace, no amplitude.
    h = amplitude_horizon(tmp_path, 204, xls=(31,))
    data = map_data(cube, h, HorizonMapState(horizon='h', color_by='amplitude', display='filled'))
    assert data['z'] == [[None], [None]]
    assert data['vmin'] < 0 < data['vmax']
    assert len(data['contours']) == 0  # display='filled'.


def test_amplitude_publication_render(cube, tmp_path):
    content = render_map(
        cube,
        amplitude_horizon(tmp_path, 204),
        HorizonMapState(horizon='h', color_by='amplitude', interval=2),
        Settings(),
    )
    assert content.startswith(b'\x89PNG')


def test_amplitude_needs_a_survey(tmp_path):
    h = amplitude_horizon(tmp_path, 204)
    with pytest.raises(ValueError):
        map_data(None, h, HorizonMapState(horizon='h', color_by='amplitude'))


def test_amplitude_map_api(client):
    response = client.post('/api/horizon-map', json={'horizon': 'h', 'color_by': 'amplitude'})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['color_by'] == 'amplitude' and data['colorbar_title'] == 'Amplitude'
    assert data['vmin'] == pytest.approx(-data['vmax'])


def test_amplitude_handles_footprints_outside_the_cube(cube, tmp_path):
    # Horizon footprints may extend past the survey (like full 3D surfaces do);
    # amplitude is simply invalid outside the cube instead of crashing the read.
    p = tmp_path / 'beyond.txt'
    p.write_text(''.join(f'{il} {xl} 204\n' for il in (10, 12, 14) for xl in (30, 33)))
    h = Horizon(p)
    data = map_data(cube, h, HorizonMapState(horizon='h', color_by='amplitude', display='filled'))
    assert data['z'] == [[1031, 1034], [1231, 1234], [None, None]]
