"""Layer-only sections and 3D scenes keep real geometry and no amplitude data."""
import xml.etree.ElementTree as ET

from fastapi.testclient import TestClient
import numpy as np
import pytest

import backend.main as server
from backend.horizon import Horizon
from backend.horizon_geometry import HorizonGeometry, has_seismic
from backend.horizon_display import json_points, sg_section
from backend.models import Horizon3DStyle, SectionRequest, Settings, ViewState, ViewState3D
from backend.rendering import render_with_metadata
from backend.scene import horizon_mesh, scene_data
from backend.section_service import interactive_section


@pytest.fixture
def layers(tmp_path):
    paths = [tmp_path / "reference.txt", tmp_path / "comparison.txt"]
    for index, path in enumerate(paths):
        path.write_text("\n".join(f"{il} {xl} {200 + il + index * 20 + np.sin(xl)}"
                                  for il in (10, 12) for xl in range(30, 39)))
    return {str(i): Horizon(path) for i, path in enumerate(paths)}


def styles(layers, **extra):
    return [Horizon3DStyle(id=key, name=h.name, **extra) for key, h in layers.items()]


def test_geometry_is_sparse_pick_extent_not_fake_volume(layers, tmp_path):
    geometry = HorizonGeometry(layers)
    assert not has_seismic(geometry)
    meta = geometry.metadata()
    assert meta["inlines"] == [10, 12]
    assert meta["crosslines"] == list(range(30, 39))
    assert (meta["samples"], meta["sample_interval"], meta["traces"]) == (0, 0, 0)
    assert len(geometry.times) == 2
    assert not hasattr(geometry, "path") and not hasattr(geometry, "section")
    path = tmp_path / "sparse.txt"
    path.write_text("10 30 200\n1000000000 2000000000 200\n")
    sparse = HorizonGeometry({"h": Horizon(path)})
    assert sparse.inlines.tolist() == [10, 1000000000]
    assert sparse.times.tolist() == [199.5, 200.5]
    with pytest.raises(ValueError):
        HorizonGeometry({})


@pytest.mark.parametrize("mode,section", [("inline", 10), ("crossline", 33)])
def test_sections_have_only_real_picks_and_shared_sg(layers, mode, section):
    geometry = HorizonGeometry(layers)
    before = {key: h.data.copy() for key, h in layers.items()}
    req = SectionRequest(view_type=mode, section_number=section, horizon_sg=True,
                         seismic={"wiggle": True, "variable_area": True, "background_interpolation": True})
    data = interactive_section(geometry, layers, req)
    assert data["has_seismic"] is False and data["z"] == []
    assert data["vmin"] is None and data["vmax"] is None
    assert "trace_overlay" not in data
    x, _ = geometry.section_axes(mode, section)
    for key, h in layers.items():
        assert data["horizons"][key] == h.section(mode, section)
        assert data["horizon_display"]["points"][key] == json_points(sg_section(h, mode, section, 7, x))
        np.testing.assert_array_equal(h.data, before[key])


def test_scene_geometry_frames_surface_and_intersections_without_volume(layers):
    geometry = HorizonGeometry(layers)
    time = float(np.mean(geometry.times))
    state = ViewState3D(horizons=[
        Horizon3DStyle(id="0", name="surface", color_by="twt"),
        Horizon3DStyle(id="1", name="intersections", display_mode="slice_intersections"),
    ], slices={"inline": [{"id": "il", "position": 10}],
               "crossline": [{"id": "xl", "position": 33}],
               "time": [{"id": "t", "position": time}]},
        seismic={"wiggle": True, "variable_area": True})
    data = scene_data(geometry, layers, state)
    assert data["has_seismic"] is False and data["vmin"] is None and data["vmax"] is None
    assert len(data["slices"]) == 3
    for frame in data["slices"]:
        assert frame["geometry_only"] and frame["amplitude"] == []
        assert "trace_overlay" not in frame
    assert data["slices"][-1]["position"] == time  # Continuous TWT, no fake sample snapping.
    assert data["horizons"]["0"]["mesh"] == horizon_mesh(layers["0"])
    lines = data["horizons"]["1"]["intersections"]
    inline = next(line for line in lines if line["slice_id"] == "il")
    assert inline["x"] == list(range(30, 39))
    assert inline["z"] == [point[1] for point in layers["1"].section("inline", 10)]


def test_only_amplitude_surface_requires_seismic(layers):
    geometry = HorizonGeometry(layers)
    with pytest.raises(ValueError, match="SEG-Y"):
        scene_data(geometry, layers, ViewState3D(horizons=styles(layers, color_by="amplitude")))
    result = scene_data(geometry, layers, ViewState3D(horizons=styles(layers, color_by="solid")))
    assert len(result["horizons"]) == 2


@pytest.mark.parametrize("sg,smooth", [(False, False), (False, True), (True, False), (True, True)])
def test_horizon_section_export_contains_vectors_and_no_amplitude_image(layers, monkeypatch, sg, smooth):
    import backend.rendering as rendering
    original = {key: h.data.copy() for key, h in layers.items()}
    def reject_amplitude(*args, **kwargs):
        raise AssertionError("No amplitude processing is valid without a seismic source")
    monkeypatch.setattr(rendering, "amplitude", reject_amplitude)
    state = ViewState(section_number=10, horizons=styles(layers, marker={"visible": True}),
                      horizon_sg=sg, smooth_horizons=smooth,
                      seismic={"wiggle": True, "variable_area": True, "background_interpolation": True})
    result = render_with_metadata(HorizonGeometry(layers), layers, state,
                                  Settings(format="svg", long_edge=600))
    assert result.colorbar_range is None
    root = ET.fromstring(result.data)
    ns = "{http://www.w3.org/2000/svg}"
    assert not list(root.iter(ns + "image"))
    assert len(list(root.iter(ns + "path"))) > 2
    for key, h in layers.items():
        np.testing.assert_array_equal(h.data, original[key])


def test_workspace_geometry_and_section_scene_endpoints_without_segy(layers, monkeypatch):
    client = TestClient(server.app)
    picked = client.post("/api/horizons/pick", json={"paths": [str(h.path) for h in layers.values()]}).json()
    imported = client.post("/api/horizons/local", json={"token": picked["token"]}).json()
    workspace = client.get("/api/workspace").json()
    assert workspace["metadata"] is None
    assert workspace["horizon_metadata"]["inlines"] == [10, 12]
    section = client.post("/api/section", json={"section_number": 10})
    assert section.status_code == 200 and section.json()["z"] == []
    scene = client.post("/api/scene", json={"horizons": imported})
    assert scene.status_code == 200 and len(scene.json()["horizons"]) == 2
    assert client.post("/api/sample", json={"kind": "inline", "position": 10, "crossline": 30, "time": 210}).status_code == 400
