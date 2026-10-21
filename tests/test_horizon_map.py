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
    assert data['color_by'] == 'twt' and data['colorbar_title'] == 'Time (ms)'
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
@pytest.mark.parametrize('include_profile', [False, True])
def test_map_publication_export(tmp_path, fmt, signature, include_profile):
    from backend.models import MapProfileOverlay
    h = make_horizon(tmp_path, True)
    profile = MapProfileOverlay(a=(1, 1), b=(3, 3)) if include_profile else None
    content = render_map(None, h, HorizonMapState(horizon='h', interval=2, labels=True, x_range=(1, 4), y_range=(0, 3)), Settings(format=fmt, width=100, height=100), profile=profile)
    assert content.startswith(signature)


def test_map_export_preserves_ab_coordinates_extensions_and_zoom(tmp_path, monkeypatch):
    from backend.models import MapProfileOverlay
    figures = []

    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig

    from matplotlib.figure import Figure
    monkeypatch.setattr('backend.horizon_map.Figure', capture)
    profile = MapProfileOverlay(a=(1, 1), b=(3, 3), path_start=(.7, .7), path_end=(3.3, 3.3))
    state = HorizonMapState(horizon='h', x_range=(0, 4), y_range=(.5, 3.5))
    content = render_map(None, make_horizon(tmp_path), state,
                         Settings(format='svg', long_edge=600), profile=profile)
    ax = figures[0].axes[0]
    line = next(line for line in ax.lines if line.get_gid() == 'map-ab-line')
    np.testing.assert_array_equal(line.get_xydata(), [[1, 1], [3, 3]])
    assert len([line for line in ax.lines if (line.get_gid() or '').startswith('map-ab-extension')]) == 2
    assert [text.get_text() for text in ax.texts] == ['A', 'B']
    assert ax.get_xlim() == (0, 4) and ax.get_ylim() == (.5, 3.5)
    assert b'id="map-ab-line"' in content
    assert b'id="map-ab-label-a"' in content and b'id="map-ab-label-b"' in content


@pytest.mark.parametrize('enabled', [False, True])
def test_map_export_api_ab_overlay_is_optional(client, enabled):
    response = client.post('/api/horizon-map/export', json={
        'state': {'horizon': 'h'}, 'settings': {'format': 'svg', 'long_edge': 600},
        'profile': {'a': [10, 30], 'b': [12, 33]} if enabled else None,
    })
    assert response.status_code == 200, response.text
    assert (b'id="map-ab-line"' in response.content) is enabled
    assert (b'id="map-ab-label-a"' in response.content) is enabled


@pytest.mark.parametrize('profile', [
    {'a': [10, 30]},
    {'a': [10, 30], 'b': [10, 30]},
    {'a': ['NaN', 30], 'b': [12, 33]},
])
def test_map_export_rejects_invalid_ab_overlay(client, profile):
    response = client.post('/api/horizon-map/export', json={
        'state': {'horizon': 'h'}, 'settings': {}, 'profile': profile,
    })
    assert response.status_code == 422


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
    # The horizon Time extent stays a Time range even for amplitude maps.
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
    assert data["colorbar_title"] == "ΔTime (ms)"
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
    assert data["colorbar_title"] == "|ΔTime| (ms)"
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


@pytest.mark.parametrize("difference_type,show_title,expected", [
    ("signed", True, "Signed Difference: Prediction − Reference"),
    ("absolute", True, "Absolute Difference: |Prediction − Reference|"),
    ("signed", False, None),
])
def test_difference_export_title_uses_the_actual_pair(tmp_path, difference_type, show_title, expected):
    import xml.etree.ElementTree as ET

    grid = grid_horizon(tmp_path, "Unrelated.txt", lambda y, x: 200 + y + x)
    reference = grid_horizon(tmp_path, "Reference.txt", lambda y, x: 200 + y + x)
    comparison = grid_horizon(tmp_path, "Prediction.txt", lambda y, x: 202 + y + x)
    content = render_map(
        None, grid,
        difference_state("grid", "ref", "comp", difference_type=difference_type, display="filled"),
        Settings(canvas="fit", format="svg", long_edge=600, show_title=show_title),
        {"grid": grid, "ref": reference, "comp": comparison},
    )
    root = ET.fromstring(content)
    texts = ["".join(node.itertext()) for node in root.iter("{http://www.w3.org/2000/svg}text")]
    assert "Unrelated" not in texts
    if expected is not None:
        assert expected in texts
    else:
        assert not any("Difference:" in text for text in texts)


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
    assert data["colorbar_title"] == "ΔTime (ms)"
    assert data["statistics"]["mae"] == 2.0 and data["statistics"]["bias"] == 2.0


# ------------------------------------------------------------------ A–B profile


from backend.horizon_map import map_profile  # noqa: E402


def test_profile_section_interpolates_between_traces(cube):
    # A sits on the extent edge; B can still extend 15% deeper into the survey.
    result = map_profile(cube, None, HorizonMapState(horizon="h"), {}, (10, 30), (10, 33))
    assert result["a_distance"] == 0 and result["b_distance"] == 3
    assert result["distance"][-1] == pytest.approx(3.45)
    assert result["time"] == [200.0, 204.0, 208.0, 212.0]
    assert result["label_y"] == "Time (ms)"
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


@pytest.fixture
def boundary_cube(tmp_path):
    """Sparse test volume with the same outer coordinates as the F3 survey."""
    import segyio
    from backend.core import Survey

    path = tmp_path / "boundary.segy"
    spec = segyio.spec()
    spec.sorting, spec.format = 2, 5
    spec.samples = list(range(200, 232, 4))
    spec.ilines, spec.xlines = [110, 400, 695], [310, 700, 1205]
    with segyio.create(str(path), spec) as f:
        for k, (il, xl) in enumerate((il, xl) for il in spec.ilines for xl in spec.xlines):
            f.header[k] = {189: il, 21: xl, 109: 200, 117: 4000}
            f.trace[k] = il + xl + np.arange(len(spec.samples), dtype=np.float32)
        f.bin[segyio.BinField.Interval] = 4000
    return Survey(path)


@pytest.mark.parametrize("a,b", [
    ((115, 700), (400, 700)),  # Low inline edge.
    ((400, 700), (690, 700)),  # High inline edge.
    ((400, 315), (400, 700)),  # Low crossline edge.
    ((400, 700), (400, 1200)),  # High crossline edge.
    ((115, 320), (690, 1200)),  # Both ends exceed the extent.
    # Clipping this diagonal used to produce crossline 309.99999999999994.
    ((198.0570257963888, 741.5800874384062), (590.8100996147791, 312.4056949091382)),
])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("interpolate", [False, True])
def test_profile_clipped_extensions_include_valid_boundary_traces(boundary_cube, tmp_path, a, b, reverse, interpolate):
    from backend.models import Seismic, ViewState

    if reverse:
        a, b = b, a
    path = tmp_path / "boundary-horizon.txt"
    path.write_text("".join(f"{il} {xl} 204\n" for il in (110, 695) for xl in (310, 1205)))
    result = map_profile(
        boundary_cube, None, HorizonMapState(horizon="h"), {"h": Horizon(path)}, a, b,
        target_width=61, target_height=32,
        display_state=ViewState(section_number=0, seismic=Seismic(background_interpolation=interpolate)),
    )
    for il, xl in (result["path_start"], result["path_end"]):
        assert 110 <= il <= 695 and 310 <= xl <= 1205
    # Neither the background nor the interpretation loses its edge sample.
    assert np.isfinite(np.asarray(result["amplitude"], dtype=float)).all()
    assert result["curves"][0]["values"] == pytest.approx([204] * len(result["curve_distance"]))
    assert 0 <= result["a_distance"] <= result["x_range"][1] + .001
    assert 0 <= result["b_distance"] <= result["x_range"][1] + .001
    if not interpolate:
        for column, endpoint in ((0, result["path_start"]), (-1, result["path_end"])):
            assert result["amplitude"][0][column] == pytest.approx(sum(endpoint))


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
    # Shared Sinc8/linear reconstruction follows the actual subplot pixels.
    # A legacy interpolation selector cannot override the new display switch.
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
    assert len(result["distance"]) == 400
    assert len(result["time"]) == 200
    assert len(result["amplitude"]) == 200 and len(result["amplitude"][0]) == 400
    assert result["interpolation"] == "sinc8"
    # Pixel centers occupy exact source-cell edges, just like the 2D heatmap.
    assert result["time_edges"][0] == 198 and result["time_edges"][-1] == 214
    assert result["time"][0] == pytest.approx(198.04)
    assert result["time"][-1] == pytest.approx(213.96)


def test_profile_native_without_target(cube):
    result = map_profile(cube, None, HorizonMapState(horizon="h"), {}, (10, 30), (12, 38))
    n = len(result["distance"])
    assert len(result["amplitude"][0]) == n


def test_profile_curves_keep_original_world_coordinates(cube, tmp_path):
    # Horizon path coordinates stay independent of the background pixel grid.
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
    horizons = {"h": full, "g": Horizon(p)}
    result = map_profile(
        cube,
        None,
        HorizonMapState(horizon="h"),
        horizons,
        (10, 30),
        (12, 38),
        target_width=15,
        target_height=12,
    )
    curves = {c["id"]: c for c in result["curves"]}
    assert len(curves["h"]["values"]) == len(result["curve_distance"]) == 5
    assert len(result["distance"]) == 15
    assert all(v == pytest.approx(204) for v in curves["h"]["values"])
    # The missing pick (10, 34) invalidates every display column whose bilinear
    # stencil touches it: the gap spans the path where crossline is in (32, 36)
    # — the same distance range as at native sampling, just finer sampled.
    gap = [
        x
        for x, v in zip(result["curve_distance"], curves["g"]["values"])
        if v is None
    ]
    assert len(gap) >= 1
    # Distance of path points at xline 32 and 36 along the 8.25-long diagonal.
    lo, hi = 0.25 * 8.246, 0.75 * 8.246
    assert all(lo < x < hi for x in gap)


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
    assert len(data["distance"]) == 300 and len(data["time"]) == 150
    assert data["interpolation"] == "sinc8"


# ------------------------------------------------------------- profile export


@pytest.mark.parametrize(
    "fmt,signature", [("png", b"\x89PNG"), ("pdf", b"%PDF"), ("svg", b"<?xml")]
)
def test_render_profile_publication(cube, tmp_path, fmt, signature):
    from backend.horizon_map import render_profile

    full = amplitude_horizon(tmp_path, 204, xls=(30, 32, 34, 36, 38))
    horizons = {"h": full}
    content, info = render_profile(
        cube,
        HorizonMapState(horizon="h", colorbar=True),
        horizons,
        (10, 30),
        (12, 38),
        Settings(format=fmt, width=180, height=80),
        {"h": "#f5b942"},
        colormap="seismic",
    )
    assert content.startswith(signature)
    assert info["a"] == [10.0, 30.0] and info["b"] == [12.0, 38.0]
    assert info["curves"] == ["amp"]  # horizon name, not its queue id
    assert info["a_distance"] == pytest.approx(0)  # A sits on the extent corner


def test_render_profile_uses_curve_colors(cube, tmp_path, monkeypatch):
    from matplotlib.figure import Figure
    from backend.horizon_map import render_profile

    figures = []

    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig

    monkeypatch.setattr("backend.horizon_map.Figure", capture)
    full = amplitude_horizon(tmp_path, 204, xls=(30, 32, 34, 36, 38))
    render_profile(
        cube,
        HorizonMapState(horizon="h"),
        {"h": full},
        (10, 30),
        (12, 38),
        Settings(),
        {"h": "#f5b942"},
    )
    lines = figures[0].axes[0].get_lines()
    overlay = [ln for ln in lines if ln.get_color() == "#f5b942"]
    assert overlay and overlay[0].get_label() == "amp"


def test_profile_export_queue_naming_and_manifest(client, tmp_path):
    p = tmp_path / "ov.txt"
    p.write_text("10 30 204\n10 33 205\n12 30 206\n12 33 208\n")
    import backend.main as server

    server.horizons["ov"] = Horizon(p)
    try:
        response = client.post(
            "/api/export/queue",
            json={
                "kind": "profile",
                "dataset": "F3",
                "state": {"horizon": "h"},
                "a": [10, 30],
                "b": [12, 33],
                "curve_colors": {"ov": "#42ddbc"},
                "colormap": "seismic",
                "settings": {"format": "png", "width": 180, "height": 80, "dpi": 300},
            },
        )
    finally:
        server.horizons.pop("ov", None)
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["view_type"] == "horizon_map"
    assert item["folder"] == "HorizonMap"
    assert item["filename"].startswith("F3_HorizonMap_h_Seismic_ProfileAB_")
    assert "180x80mm_300dpi.png" in item["filename"]


def test_profile_export_rejects_bad_colors(client):
    response = client.post(
        "/api/export/queue",
        json={
            "kind": "profile",
            "state": {"horizon": "h"},
            "a": [10, 30],
            "b": [12, 33],
            "curve_colors": {"ov": "orange"},
        },
    )
    assert response.status_code == 422


def test_render_profile_removable_furniture(cube, tmp_path, monkeypatch):
    from matplotlib.figure import Figure
    from backend.horizon_map import render_profile

    figures = []

    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig

    monkeypatch.setattr("backend.horizon_map.Figure", capture)
    full = amplitude_horizon(tmp_path, 204, xls=(30, 32, 34, 36, 38))
    horizons = {"h": full}
    common = dict(
        state=HorizonMapState(horizon="h"),
        horizons=horizons,
        a=(10, 30),
        b=(12, 38),
        settings=Settings(),
    )
    # Everything on by default: curve + A/B lines exist, legend present.
    render_profile(cube, **common, curve_colors={"h": "#f5b942"})
    lines = figures[0].axes[0].get_lines()
    assert any(ln.get_color() == "#f5b942" for ln in lines)
    assert sum("dashdot" not in str(ln.get_linestyle()) for ln in lines) >= 1
    assert figures[0].axes[0].get_legend() is not None
    # All furniture removed: only the (empty) axes remain.
    render_profile(
        cube, **common, show_curves=False, show_legend=False, show_ab=False
    )
    axes = figures[1].axes[0]
    overlay = [
        ln
        for ln in axes.get_lines()
        if ln.get_color() == "#f5b942" or ln.get_linestyle() in ("--", (0, (4, 3)))
    ]
    assert overlay == []
    assert axes.get_legend() is None


def test_colormap_menu_previews_match_map_renderer_without_expanding_seismic_choices(tmp_path):
    from typing import get_args
    from fastapi.testclient import TestClient
    import backend.main as server
    from backend.style import CMAPS

    catalog = TestClient(server.app).get('/api/catalog').json()
    assert list(catalog['colormaps']) == CMAPS
    palettes = catalog['map_colormaps']
    assert set(palettes) == set(get_args(HorizonMapState.model_fields['colormap'].annotation))
    horizon = make_horizon(tmp_path)
    for name, colors in palettes.items():
        rendered = map_data(None, horizon, HorizonMapState(horizon='h', colormap=name))
        assert colors == rendered['colorscale']
        reversed_map = map_data(None, horizon, HorizonMapState(horizon='h', colormap=name, reverse_colormap=True))
        assert colors[0][1] == reversed_map['colorscale'][-1][1]
        assert colors[-1][1] == reversed_map['colorscale'][0][1]
