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


def test_profile_section_interpolates_between_traces(cube):
    # A sits on the extent edge; B can still extend 15% deeper into the survey.
    result = map_profile(cube, None, HorizonMapState(horizon="h"), {}, (10, 30), (10, 33))
    assert result["a_distance"] == 0 and result["b_distance"] == 3
    assert result["distance"][-1] == pytest.approx(3.45)
    assert result["time"] == [200.0, 204.0, 208.0, 212.0]
    assert result["label_y"] == "TWT (ms)"
    # Amplitude is time-major: amplitude[time][position]. Fractional positions
    # blend the four surrounding traces linearly.
    assert result["amplitude"][0][0] == 1030
    assert result["amplitude"][0][1] == pytest.approx(1031.725)
    assert result["amplitude"][0][-1] == pytest.approx(1033.45)
    assert result["amplitude"][1][0] == 1031
    # Display range is symmetric around zero.
    assert result["vmin"] == pytest.approx(-result["vmax"])
    assert result["curves"] == []
    # The reported path ends are the clipped extended end points.
    assert result["path_start"] == [10.0, 30.0]
    assert result["path_end"] == [10.0, 33.45]
    # Distance runs from the section start, strictly increasing.
    assert result["distance"][0] == 0
    assert all(b > a for a, b in zip(result["distance"], result["distance"][1:]))


def test_profile_extends_and_stays_inside_the_survey(cube):
    # Interior line: both ends extend by 15% of the A–B length.
    result = map_profile(cube, None, HorizonMapState(horizon="h"), {}, (11, 31), (11, 32))
    assert result["a_distance"] == pytest.approx(0.15, abs=0.01)
    assert result["b_distance"] == pytest.approx(1.15, abs=0.01)
    # Every interpolated sample is inside the cube and therefore finite.
    assert all(v is not None for row in result["amplitude"] for v in row)


def test_profile_horizon_overlays_follow_the_same_path(cube, tmp_path):
    full = amplitude_horizon(tmp_path, 204, xls=(30, 32, 34, 36, 38))
    p = tmp_path / "gapped.txt"
    p.write_text(
        "".join(
            f"{il} {xl} 204\n"
            for il in (10, 12)
            for xl in (30, 32, 34, 36, 38)
            if (il, xl) != (10, 34)
        )
    )
    gapped = Horizon(p)
    horizons = {"h": full, "g": gapped}
    result = map_profile(
        cube, None, HorizonMapState(horizon="h"), horizons, (10, 30), (12, 38)
    )
    curves = {c["id"]: c for c in result["curves"]}
    # Both horizons sampled along the exact same diagonal path.
    assert curves["h"]["values"][0] == 204 and curves["h"]["values"][-1] == 204
    assert curves["h"]["values"].count(None) == 0
    # The gapped horizon breaks where the path crosses its missing pick.
    assert curves["g"]["values"].count(None) == 1
    assert curves["g"]["name"] == "gapped"


def test_profile_requires_survey(tmp_path):
    with pytest.raises(ValueError):
        map_profile(None, None, HorizonMapState(horizon="h"), {}, (0, 0), (4, 0))


def test_profile_rejects_degenerate_endpoints(cube):
    with pytest.raises(ValueError):
        map_profile(cube, None, HorizonMapState(horizon="h"), {}, (1, 1), (1, 1))
    with pytest.raises(ValueError):
        map_profile(cube, None, HorizonMapState(horizon="h"), {}, (0, 0), (4, float("nan")))
    with pytest.raises(ValueError):
        map_profile(cube, None, HorizonMapState(horizon="h"), {}, (0, 0), (0, 0) if False else (5, 30) if False else (0, 0))


def test_profile_api(client):
    response = client.post(
        "/api/horizon-map/profile",
        json={"state": {"horizon": "h"}, "a": [10, 30], "b": [12, 33]},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["time"] == [200.0, 204.0, 208.0, 212.0]
    assert data["amplitude"][0][0] == 1030
    assert data["curves"][0]["id"] == "h"
    assert data["curves"][0]["name"] == "h"


def test_profile_display_resampling(cube):
    # Adaptive: the raster is fitted to the target pixels with bilinear, but
    # never upsampled beyond 3x the native grid (same guard as /api/section).
    result = map_profile(
        cube,
        None,
        HorizonMapState(horizon="h"),
        {},
        (10, 30),
        (12, 38),
        target_width=400,
        target_height=200,
        interpolation="bilinear",
    )
    # Native path grid is 5 x 4 (tiny cube): 3x cap gives 15 x 12.
    assert len(result["distance"]) == 15
    assert len(result["time"]) == 12
    assert len(result["amplitude"]) == 12 and len(result["amplitude"][0]) == 15
    # Coordinate axes are resampled linspaces spanning the native extent.
    assert result["distance"][0] == pytest.approx(0)
    assert result["time"][0] == 200.0 and result["time"][-1] == 212.0


def test_profile_native_without_target(cube):
    result = map_profile(cube, None, HorizonMapState(horizon="h"), {}, (10, 30), (12, 38))
    n = len(result["distance"])
    assert len(result["amplitude"][0]) == n


def test_profile_resampling_api(client):
    response = client.post(
        "/api/horizon-map/profile",
        json={
            "state": {"horizon": "h"},
            "a": [10, 30],
            "b": [12, 38],
            "target_width": 300,
            "target_height": 150,
            "interpolation": "bicubic",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    # 3x upsample cap of the 5 x 4 native grid.
    assert len(data["distance"]) == 15 and len(data["time"]) == 12
