"""SEG-Y is a replaceable source; project work survives volume changes."""
from copy import deepcopy
from pathlib import Path

import numpy as np
import pytest
import segyio

import backend.main as server
from backend.horizon_map import sample_amplitude
from backend.scene import horizon_grid, horizon_amplitude_mesh
from test_workspace import open_project, drawing_state, save, restart


@pytest.mark.parametrize("entry", ["local", "pick", "upload"])
def test_switch_keeps_project_layers_settings_and_frozen_figures(cube, wide_cube, monkeypatch, entry):
    client, original = open_project(cube)
    layers = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n12 33 208\n"))]).json()
    state = drawing_state(layers)
    state["view"]["horizons"][0].update(model_group="Base", horizon_key="T24")
    assert save(client, original, state).status_code == 200
    queued = client.post("/api/export/queue", json={"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}})
    assert queued.status_code == 200, queued.text
    item = queued.json()
    image = Path(item["temporary_path"]).read_bytes()
    folder = server.project.export_folder()
    old_headers = {"X-SeisCanvas-Project": original["project_id"], "X-SeisCanvas-Epoch": original["activation_epoch"]}
    if entry == "upload":
        with wide_cube.path.open("rb") as stream:
            response = client.post("/api/segy", files={"file": ("wide.segy", stream)})
    elif entry == "pick":
        monkeypatch.setattr(server, "choose_segy", lambda: str(wide_cube.path))
        response = client.post("/api/segy/pick", json={})
    else:
        response = client.post("/api/segy/local", json={"path": str(wide_cube.path)})
    assert response.status_code == 200, response.text
    switched = response.json()
    assert switched["project_id"] == original["project_id"]
    assert switched["name"] == original["name"]
    assert switched["activation_epoch"] != original["activation_epoch"]
    assert switched["state"] == state
    assert switched["horizons"] == state["view"]["horizons"]
    assert len(client.get("/api/projects").json()["projects"]) == 1
    assert client.get("/api/export/queue").json()["count"] == 1
    assert server.project.export_folder() == folder
    assert Path(item["temporary_path"]).read_bytes() == image
    assert client.get(f"/api/export/queue/{item['id']}/settings").status_code == 400
    assert client.post("/api/section", json={"section_number": 12}, headers=old_headers).status_code == 409
    restart()
    restored = client.get("/api/workspace").json()
    assert restored["project_id"] == original["project_id"]
    assert restored["metadata"]["filename"] == "wide.segy"
    assert restored["state"] == state
    back = client.post("/api/segy/local", json={"path": str(cube.path)}).json()
    assert back["project_id"] == original["project_id"] and back["state"] == state
    assert client.get(f"/api/export/queue/{item['id']}/settings").status_code == 200
    assert Path(item["temporary_path"]).read_bytes() == image


def test_switch_repairs_only_out_of_bounds_positions_and_updates_read_parameters(cube, wide_cube):
    client, original = open_project(wide_cube)
    state = drawing_state([])
    state["view"].update(section_number=87, x_range=[16, 18], time_range=[260, 270])
    state["view"]["slices"]["inline"][0]["position"] = 18
    state["geometryMode"] = "regular"
    assert save(client, original, state).status_code == 200
    result = client.post("/api/segy/local", json={"path": str(cube.path), "xlbyte": 193, "geometry_mode": "auto"})
    assert result.status_code == 200, result.text
    expected = deepcopy(state)
    expected["view"].update(section_number=38, x_range=None, time_range=None)
    expected["view"]["slices"]["inline"][0]["position"] = 12
    expected.update(bytes={"il": 189, "xl": 193}, geometryMode="auto")
    assert result.json()["state"] == expected


def test_failed_or_cancelled_switch_preserves_current_work(cube, tmp_path, monkeypatch):
    client, original = open_project(cube)
    current, epoch = deepcopy(server.project.read()), server.project.epoch
    survey = server.survey
    invalid = tmp_path / "bad.segy"
    invalid.write_bytes(b"not seismic data")
    assert client.post("/api/segy/local", json={"path": str(invalid)}).status_code == 400
    monkeypatch.setattr(server, "choose_segy", lambda: None)
    assert client.post("/api/segy/pick", json={}).json() == {"cancelled": True}
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr("backend.workspace.atomic_json", fail)
    assert client.post("/api/segy/local", json={"path": str(cube.path)}).status_code == 400
    assert server.project.read() == current and server.project.epoch == epoch
    assert server.survey is survey


def test_preserved_horizons_read_amplitudes_from_new_volume(cube, tmp_path):
    client, _ = open_project(cube)
    styles = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n10 33 204\n12 30 208\n12 33 208\n"))]).json()
    h = server.horizons[styles[0]["id"]]
    x, y, times = horizon_grid(h)
    amplitude = sample_amplitude(server.survey, h, x, y, times).copy()
    mesh = horizon_amplitude_mesh(server.survey, h)
    replacement = tmp_path / "other.segy"
    replacement.write_bytes(cube.path.read_bytes())
    with segyio.open(str(replacement), "r+", ignore_geometry=True) as f:
        for i in range(f.tracecount):
            f.trace[i] = f.trace[i] + 500
    response = client.post("/api/segy/local", json={"path": str(replacement)})
    assert response.status_code == 200, response.text
    assert server.horizons[styles[0]["id"]] is h
    assert not hasattr(h, "_amplitude3d") and not hasattr(h, "_amplitude_mesh3d")
    assert horizon_grid(h)[0] is x
    np.testing.assert_allclose(sample_amplitude(server.survey, h, x, y, times), amplitude + 500)
    np.testing.assert_allclose(horizon_amplitude_mesh(server.survey, h)["amplitude"], np.array(mesh["amplitude"]) + 500)
    # Independent readers must also include the volume in their cache identity.
    np.testing.assert_allclose(sample_amplitude(cube, h, x, y, times), amplitude)
