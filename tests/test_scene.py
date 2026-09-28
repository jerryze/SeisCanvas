import numpy as np
import pytest
from fastapi.testclient import TestClient
from backend.core import Horizon
from backend.scene import (
    timeslice,
    slice_data,
    horizon_mesh,
    horizon_intersection,
    scene_data,
)
from backend.models import ViewState3D, Seismic
import backend.main as server
from conftest import make_horizon


def test_three_planes_use_same_samples(cube):
    il, _ = slice_data(cube, "inline", 12, 512)
    xl, _ = slice_data(cube, "crossline", 33, 512)
    ts, _ = slice_data(cube, "time", 204, 512)
    assert il["a"] == [30, 33, 38] and il["b"] == [200, 204, 208, 212]
    assert xl["a"] == [10, 12] and xl["b"] == [200, 204, 208, 212]
    assert ts["a"] == [30, 33, 38] and ts["b"] == [10, 12]
    # All three planes agree at X=33,Y=12,Z=204.
    assert (
        il["amplitude"][1][1] == xl["amplitude"][1][1] == ts["amplitude"][1][1] == 1234
    )
    actual, grid = timeslice(cube, 205)
    assert actual == 204
    assert timeslice(cube, 204)[1] is grid
    with pytest.raises(ValueError):
        timeslice(cube, 100)
    with pytest.raises(ValueError):
        slice_data(cube, "inline", 10.5)


def test_surface_orientation_and_mask(tmp_path):
    h = make_horizon(tmp_path, True)
    m = horizon_mesh(h, 5)
    assert m["x"][:5] == [0, 1, 2, 3, 4]
    assert m["y"][:5] == [0, 0, 0, 0, 0]
    assert m["z"][6] is None
    assert m["z"][14] == 208
    assert (
        len(m["i"]) == 24
    )  # 16 native quads minus four quads around hole, two triangles each
    assert all(6 not in tri for tri in zip(m["i"], m["j"], m["k"]))
    coarse = horizon_mesh(h, 3)
    # Hole at (1,1) is not itself sampled, but its whole coarse quad is omitted.
    assert len(coarse["i"]) == 6
    assert not any(
        set(tri) <= set([0, 1, 3, 4])
        for tri in zip(coarse["i"], coarse["j"], coarse["k"])
    )


def test_no_bridge_over_missing_line(tmp_path):
    p = tmp_path / "gap.txt"
    p.write_text("\n".join(f"{y} {x} 100" for y in [0, 1, 3, 4] for x in range(5)))
    m = horizon_mesh(Horizon(p), 5)
    assert m["native_shape"] == [5, 5]
    assert len(m["i"]) == 16


def test_intersections_and_tolerance(tmp_path):
    h = make_horizon(tmp_path, True)
    il = horizon_intersection(h, "inline", 1)
    assert il["x"] == [0, None, 2, 3, 4]
    assert il["y"] == [1, None, 1, 1, 1]
    xl = horizon_intersection(h, "crossline", 2)
    assert xl["x"] == [2] * 5 and xl["y"] == [0, 1, 2, 3, 4]
    time = horizon_intersection(h, "time", 204, 1)
    assert time["z"] == [204] * len(time["x"])
    assert all(abs(v - 204) <= 1 for v in time["horizon_time"])
    assert len(horizon_intersection(h, "time", 204, 0)["x"]) < len(time["x"])


def test_scene_visibility_shared_clipping_and_snapping(cube, tmp_path):
    p = tmp_path / "h.txt"
    p.write_text("10 30 204\n10 33 205\n12 30 204\n12 33 208\n")
    h = Horizon(p)
    state = ViewState3D(
        slices={
            "inline": [
                {"id": "il", "position": 10},
                {"id": "hidden", "position": 999, "visible": False},
            ],
            "time": [{"id": "t", "position": 205}],
        },
        horizons=[
            {
                "id": "h",
                "name": "h",
                "display_mode": "slice_intersections",
                "time_slice_tolerance": 0,
            }
        ],
        seismic={"clip_percentile": 100},
    )
    d = scene_data(cube, {"h": h}, state)
    assert len(d["slices"]) == 2 and d["slices"][1]["position"] == 204
    assert len(d["horizons"]["h"]["intersections"]) == 2
    assert d["horizons"]["h"]["intersections"][1]["x"] == [30, 30]
    assert d["vmax"] == 1239 and d["vmin"] == -1239
    state.horizons[0].visible = False
    assert scene_data(cube, {"h": h}, state)["horizons"] == {}
    state.seismic = Seismic(clip_mode="manual", vmin=-5, vmax=10, reverse_polarity=True)
    d = scene_data(cube, {}, state)
    assert (d["vmin"], d["vmax"]) == (-5, 10)


def test_scene_api_and_validation(cube, tmp_path):
    server.survey = cube
    server.horizons = {"h": make_horizon(tmp_path, True)}
    c = TestClient(server.app)
    assert c.get("/api/seismic/timeslice/205").json()["position"] == 204
    assert c.get("/api/seismic/inline/999").status_code == 400
    assert c.get("/api/seismic/inline/10?maximum=0").status_code == 422
    assert c.get("/api/horizons/h/surface").json()["z"][6] is None
    assert c.get("/api/horizons/h/intersection/time/204?tolerance=0").status_code == 200
    assert c.get("/api/horizons/missing/surface").status_code == 404
    assert (
        c.post(
            "/api/scene",
            json={"slices": {"inline": [{"id": "1", "position": 10, "opacity": 2}]}},
        ).status_code
        == 422
    )
    assert (
        c.post("/api/scene", json={"scene": {"aspect_ratio": [1, 0, 1]}}).status_code
        == 422
    )
    assert (
        c.post(
            "/api/scene",
            json={
                "slices": {
                    "inline": [{"id": "1", "position": 10}, {"id": "1", "position": 12}]
                }
            },
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/api/scene", json={"slices": {"crossline": [{"id": "1", "position": 33}]}}
        ).status_code
        == 200
    )


def test_surface_scalar_range_uses_native_extrema(tmp_path):
    h = make_horizon(tmp_path)
    h.data[6, 2] = 999  # Omitted by the two-by-two preview.
    coarse = horizon_mesh(h, 2)
    fine = horizon_mesh(h, 5)
    assert coarse["scalar"] == coarse["z"]
    assert coarse["twt_range"] == fine["twt_range"] == [200, 999]
    assert 999 not in coarse["scalar"]
    other = make_horizon(tmp_path)
    other.data[:, 2] += 1000
    assert horizon_mesh(other, 2)["twt_range"] == [1200, 1212]


def test_surface_defaults_and_import_range(tmp_path):
    from backend.models import Horizon3DStyle
    style = Horizon3DStyle(id="test", name="test")
    assert style.color_by == "twt" and style.horizon_colormap == "petrel"
    assert style.smooth_shading and style.lighting
    assert style.opacity == 1
    h = make_horizon(tmp_path)
    imported = server.add_horizon(h)
    try:
        assert imported["twt_range"] == (200, 212)
    finally:
        server.horizons.pop(imported["id"])


def test_slice_reads_stay_bounded_and_never_load_the_native_grid(cube, monkeypatch):
    import backend.preview as preview
    real_read = preview.read_samples
    calls = []
    def read(survey, ids, samples):
        calls.append((np.asarray(ids).size, len(samples)))
        return real_read(survey, ids, samples)
    monkeypatch.setattr(preview, 'read_samples', read)
    monkeypatch.setattr(cube, 'section', lambda *a: pytest.fail('full section read'))
    # The native slice is small, so it is read once and area-averaged down.
    plane, values = slice_data(cube, 'time', 204, 2, 'bilinear')
    assert calls == [(6, 1)]
    assert values.shape == (2, 2)
    assert plane['native_shape'] == [2, 3] and plane['render_shape'] == [2, 3]
    assert plane['interpolation'] == 'bilinear'
    slice_data(cube, 'time', 204, 2, 'bilinear')
    assert len(calls) == 1  # cached per method
    slice_data(cube, 'inline', 12, 2, 'bilinear')
    assert calls[-1] == (3, 4)  # 3 traces x 4 samples of the native inline slice


def test_slice_downsampling_is_antialiased_and_nearest_keeps_real_samples(cube):
    exact, nearest = slice_data(cube, 'time', 204, 2, 'nearest')
    assert nearest.shape == (2, 2)
    assert exact['amplitude'] == [[1031, 1039], [1231, 1239]]
    assert set(np.unique(nearest)).issubset({1031.0, 1039.0, 1231.0, 1239.0})
    smooth, bilinear = slice_data(cube, 'time', 204, 2, 'bilinear')
    assert bilinear.shape == (2, 2)
    assert not np.array_equal(bilinear, nearest)
    assert bilinear.min() >= nearest.min() and bilinear.max() <= nearest.max()


def test_slice_read_falls_back_to_the_texture_grid_when_budget_is_tight(cube, monkeypatch):
    import backend.preview as preview
    import backend.scene as scene
    calls = []
    real_read = preview.read_samples
    def read(survey, ids, samples):
        calls.append(np.asarray(ids).size)
        return real_read(survey, ids, samples)
    monkeypatch.setattr(preview, 'read_samples', read)
    monkeypatch.setattr(scene, 'SLICE_NATIVE_BUDGET', 2)
    monkeypatch.setattr(scene, 'SLICE_SUPERSAMPLE_BUDGET', 4)
    plane, values = slice_data(cube, 'time', 204, 2, 'bilinear')
    assert calls == [4]  # exactly the texture cells, no supersample
    assert values.shape == (2, 2)
    assert plane['interpolation'] == 'bilinear'


def test_horizon_geometry_is_lazy(tmp_path):
    h = make_horizon(tmp_path, True)
    horizon_intersection(h, 'inline', 1)
    assert not hasattr(h, '_grid3d')
    horizon_mesh(h, 3)
    assert not hasattr(h, '_grid3d')


def test_horizon_local_cache_and_invalidation(tmp_path, monkeypatch):
    import backend.horizon_cache as cache
    monkeypatch.setattr(cache, 'CACHE_DIR', tmp_path / 'cache')
    p = tmp_path / 'local.txt'
    p.write_text('1 2 100\n3 4 200\n')
    first = Horizon(p)
    second = Horizon(p)
    assert not first.cache_hit and second.cache_hit
    np.testing.assert_array_equal(first.data, second.data)
    p.write_text('1 2 1234\n3 4 200\n')
    assert not Horizon(p).cache_hit
    assert not Horizon(p, columns=(1, 0, 2)).cache_hit
    monkeypatch.setattr(server, 'choose_segy', lambda kind: str(p))
    c = TestClient(server.app)
    selection = c.post('/api/horizons/pick').json()
    response = c.post('/api/horizons/local', json={'token': selection['token']})
    assert response.status_code == 200
    server.horizons.pop(response.json()[0]['id'])
