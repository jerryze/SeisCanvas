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


# ---------------------------------------------------------------- difference


def grid_horizon(tmp_path, name, value, ys=range(5), xs=range(5)):
    p = tmp_path / name
    p.write_text("\n".join(f"{y} {x} {value(y, x)}" for y in ys for x in xs))
    return Horizon(p)


def difference_state(horizon_id, reference, comparison, **extra):
    return HorizonMapState(
        horizon=horizon_id,
        color_by="difference",
        difference_reference=reference,
        difference_comparison=comparison,
        **extra,
    )


def test_difference_signed_constant_offset(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 200 + 2 * y + x + 3)
    horizons = {"a": base, "b": comp}
    data = map_data(None, base, difference_state("a", "a", "b", display="filled"), horizons)
    assert data["colorbar_title"] == "ΔTWT (ms)"
    assert data["z"] == [[3.0] * 5] * 5
    # Signed differences center on zero with a symmetric auto range.
    assert data["vmin"] == pytest.approx(-data["vmax"])
    stats = data["statistics"]
    assert stats["mae"] == 3 and stats["rmse"] == 3 and stats["bias"] == 3
    assert stats["valid_ratio"] == 1.0 and stats["count"] == 25


def test_difference_absolute_range_and_label(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 200 + 2 * y + x - 4)
    horizons = {"a": base, "b": comp}
    data = map_data(
        None,
        base,
        difference_state("a", "a", "b", difference_type="absolute", colormap="viridis", display="filled"),
        horizons,
    )
    assert data["colorbar_title"] == "|ΔTWT| (ms)"
    assert data["z"] == [[4.0] * 5] * 5
    # Absolute differences grow from zero.
    assert data["vmin"] <= 0 < data["vmax"]
    assert data["statistics"]["mae"] == 4 and data["statistics"]["bias"] == -4


def test_difference_holes_excluded_from_statistics(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    p = tmp_path / "b_hole.txt"
    p.write_text(
        "\n".join(
            f"{y} {x} {200 + 2 * y + x + 2}"
            for y in range(5)
            for x in range(5)
            if (y, x) != (1, 1)
        )
    )
    horizons = {"a": base, "b": Horizon(p)}
    data = map_data(None, base, difference_state("a", "a", "b", display="filled"), horizons)
    # A missing comparison pick is a gap, never a zero.
    assert data["z"][1][1] is None
    stats = data["statistics"]
    assert stats["count"] == 24 and stats["valid_ratio"] == pytest.approx(0.96)
    assert stats["mae"] == 2 and stats["bias"] == 2


def test_difference_resamples_mismatched_grids(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    # Comparison picks every second inline: bilinear fills the in-between rows.
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 100 + y + x, ys=(0, 2, 4))
    horizons = {"a": base, "b": comp}
    data = map_data(None, base, difference_state("a", "a", "b", display="filled"), horizons)
    assert [row[0] for row in data["z"]] == [-100.0, -101.0, -102.0, -103.0, -104.0]


def test_difference_ignores_rows_outside_the_comparison(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 100 + y + x, ys=(2, 4))
    horizons = {"a": base, "b": comp}
    data = map_data(None, base, difference_state("a", "a", "b", display="filled"), horizons)
    # Comparison extent starts at inline 2: rows 0/1 have no difference,
    # row 3 interpolates between the picks at 2 and 4.
    assert [row[0] for row in data["z"]] == [None, None, -102.0, -103.0, -104.0]


def test_difference_requires_both_horizons(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    horizons = {"a": base}
    with pytest.raises(ValueError):
        map_data(None, base, difference_state("a", None, None), horizons)
    with pytest.raises(ValueError):
        map_data(None, base, difference_state("a", "a", "missing"), horizons)


def test_difference_publication_render(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 200 + 2 * y + x + 3)
    horizons = {"a": base, "b": comp}
    content = render_map(
        None,
        base,
        difference_state("a", "a", "b", interval=1, colormap="RdBu"),
        Settings(),
        horizons,
    )
    assert content.startswith(b"\x89PNG")


def test_difference_map_api(client, tmp_path):
    import backend.main as server
    from backend.core import Horizon as H

    p = tmp_path / "c.txt"
    p.write_text("10 30 206\n10 33 207\n12 30 208\n12 33 210\n")
    server.horizons["c"] = H(p)
    try:
        response = client.post(
            "/api/horizon-map",
            json={
                "horizon": "h",
                "color_by": "difference",
                "difference_reference": "h",
                "difference_comparison": "c",
            },
        )
    finally:
        server.horizons.pop("c", None)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["colorbar_title"] == "ΔTWT (ms)"
    assert data["statistics"]["mae"] == 2.0 and data["statistics"]["bias"] == 2.0


# ------------------------------------------------------------------ A–B profile


from backend.horizon_map import map_profile  # noqa: E402


def test_profile_samples_along_a_straight_line(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    result = map_profile(None, base, HorizonMapState(horizon="a"), {"a": base}, (0, 0), (0, 4))
    assert result["label_y"] == "TWT (ms)"
    assert len(result["distance"]) == len(result["curves"][0]["values"]) == 256
    # Line along inline 0 from xline 0 to 4: value 200 + x, distance == x.
    values = result["curves"][0]["values"]
    assert values[0] == 200 and values[-1] == 204
    assert result["distance"][-1] == 4
    assert result["curves"][0]["role"] == "scalar"


def test_profile_diagonal_uses_bilinear(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    result = map_profile(None, base, HorizonMapState(horizon="a"), {"a": base}, (0, 0), (4, 4))
    # Diagonal il == xl == d: value 200 + 3d, distance d * sqrt(2). The fixed
    # sample count rarely lands exactly on the midpoint, so allow one step.
    mid = len(result["distance"]) // 2
    assert result["curves"][0]["values"][mid] == pytest.approx(206, abs=0.05)
    assert result["distance"][mid] == pytest.approx(2 * np.sqrt(2), abs=0.05)


def test_profile_off_grid_positions_interpolate(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    # Halfway between inlines 0 and 1 at xline 2: (200+2*0+2 + 200+2*1+2) / 2.
    result = map_profile(None, base, HorizonMapState(horizon="a"), {"a": base}, (0.5, 2), (0.5, 3))
    assert result["curves"][0]["values"][0] == pytest.approx(203)


def test_profile_gaps_at_missing_picks(tmp_path):
    p = tmp_path / "hole.txt"
    p.write_text(
        "\n".join(
            f"{y} {x} {200 + 2 * y + x}"
            for y in range(5)
            for x in range(5)
            if (y, x) != (1, 1)
        )
    )
    h = Horizon(p)
    # Line through inline 1 crosses the hole at xline 1: the two cells sharing
    # that pick cannot be interpolated and the curve gaps instead of bridging.
    result = map_profile(None, h, HorizonMapState(horizon="a"), {"a": h}, (1, 0), (1, 4))
    values = result["curves"][0]["values"]
    assert values.count(None) == 128
    valid = [v for v in values if v is not None]
    assert len(valid) == 128 and all(204 <= v <= 206 for v in valid)


def test_profile_difference_mode_returns_two_curves(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    comp = grid_horizon(tmp_path, "b.txt", lambda y, x: 200 + 2 * y + x + 3)
    horizons = {"a": base, "b": comp}
    state = difference_state("a", "a", "b")
    result = map_profile(None, base, state, horizons, (0, 0), (4, 0))
    assert [c["role"] for c in result["curves"]] == ["reference", "comparison"]
    assert [c["name"] for c in result["curves"]] == ["a", "b"]
    # Reference follows its own TWT; comparison sits 3 ms deeper.
    assert result["curves"][0]["values"][-1] == 208
    assert result["curves"][1]["values"][-1] == 211
    assert result["label_y"] == "TWT (ms)"


def test_profile_rejects_degenerate_endpoints(tmp_path):
    base = grid_horizon(tmp_path, "a.txt", lambda y, x: 200 + 2 * y + x)
    horizons = {"a": base}
    with pytest.raises(ValueError):
        map_profile(None, base, HorizonMapState(horizon="a"), horizons, (1, 1), (1, 1))
    with pytest.raises(ValueError):
        map_profile(None, base, HorizonMapState(horizon="a"), horizons, (0, 0), (4, float("nan")))


def test_profile_api(client):
    response = client.post(
        "/api/horizon-map/profile",
        json={"state": {"horizon": "h"}, "a": [10, 30], "b": [12, 33]},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["curves"][0]["name"] == "h"
    assert data["a"] == [10.0, 30.0] and data["b"] == [12.0, 33.0]
    assert data["label_y"] == "TWT (ms)"
    # Endpoints sample the exact picks of the conftest horizon.
    assert data["curves"][0]["values"][0] == 204
    assert data["curves"][0]["values"][-1] == 208
