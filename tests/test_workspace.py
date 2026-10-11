"""Refresh/restart recovery, source identity and durable export contracts."""
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from fastapi.testclient import TestClient
import numpy as np
import pytest

import backend.main as server
from backend import export_queue
from backend.storage import atomic_json, read_json
from backend.workspace import WorkspaceStore


def open_project(cube):
    client = TestClient(server.app)
    result = client.post("/api/segy/local", json={"path": str(cube.path), "ilbyte": 189, "xlbyte": 21}).json()
    return client, result


def import_horizons(client, tmp_path, monkeypatch):
    paths = [tmp_path / "reference.dat", tmp_path / "comparison.txt"]
    for index, path in enumerate(paths):
        path.write_text(f"TWT IL XL\n{204+index} 10 30\n{208+index} 12 33\n")
    monkeypatch.setattr(server, "choose_segy", lambda *args, **kwargs: paths)
    preview = client.post("/api/horizons/pick").json()
    response = client.post("/api/horizons/local", json={
        "token": preview["token"], "inline_column": 1, "xline_column": 2, "time_column": 0,
    })
    assert response.status_code == 200, response.text
    return response.json(), paths


def drawing_state(horizons):
    return {
        "version": 1,
        "view": {
            "view_mode": "map", "view_type": "crossline", "section_number": 33,
            "x_range": [10, 12], "time_range": [201, 210], "aspect_ratio_2d": [1.3, 0.8],
            "seismic": {"colormap": "red_white_blue", "reverse_polarity": True},
            "scene": {"aspect_ratio": [1, 1, 1.2], "camera": {"eye": {"x": -1, "y": 2, "z": 0.5}, "projection": {"type": "orthographic"}}},
            "slices": {"inline": [{"id": "slice-1", "position": 12, "opacity": 0.4}], "crossline": [], "time": []},
            "horizons": [{**h, "opacity": 0.6, "lighting": False, "color": "#123456"} for h in horizons],
        },
        "map": {
            "state": {"horizon": horizons[0]["id"] if horizons else "", "color_by": "difference", "difference_reference": horizons[0]["id"] if horizons else None,
                      "difference_comparison": horizons[-1]["id"] if horizons else None, "difference_type": "absolute", "x_range": [29, 34], "y_range": [9, 13]},
            "profileOn": True, "profileA": [10, 30], "profileB": [12, 33], "settings": {"format": "svg"}, "profileSettings": {"show_legend": False},
        },
        "settings": {"format": "pdf", "long_edge": 3600}, "settings3D": {"format": "svg"},
        "dataset": "科研数据", "selected": horizons[0]["id"] if horizons else "",
        "bytes": {"il": 189, "xl": 21}, "geometryMode": "auto", "sidebar": False, "drag": "pan",
    }


def save(client, result, state, revision=0):
    return client.put("/api/workspace", json={"project_id": result["project_id"], "revision": revision, "state": state})


def restart():
    root = server.project.root
    server.project = WorkspaceStore(root)
    server.restored_project = None
    server.survey = None
    server.horizons.clear()
    export_queue.shutdown()


def test_refresh_and_restart_restore_all_settings_and_stable_sources(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    styles, paths = import_horizons(client, tmp_path, monkeypatch)
    state = drawing_state(styles)
    assert save(client, result, state).status_code == 200
    refreshed = TestClient(server.app).get("/api/workspace").json()
    assert refreshed["state"] == state
    assert refreshed["project_id"] == result["project_id"]
    restart()
    restored = client.get("/api/workspace").json()
    assert restored["issues"] == []
    assert restored["state"] == state
    assert restored["revision"] == 1
    assert restored["metadata"]["filename"] == "tiny.segy"
    assert [h["id"] for h in restored["horizons"]] == [h["id"] for h in styles]
    assert all(h["opacity"] == 0.6 and not h["lighting"] for h in restored["horizons"])
    np.testing.assert_array_equal(server.horizons[styles[0]["id"]].data, [[10, 30, 204], [12, 33, 208]])
    assert server.project.document["horizons"][0]["columns"] == [1, 2, 0]


def test_fresh_python_process_recovers_saved_project_and_rendered_queue(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    state = drawing_state([])
    assert save(client, result, state).status_code == 200
    item = client.post("/api/export/queue", json={"kind": "2d", "dataset": "Restart", "state": {"section_number": 12}, "settings": {"format": "png"}}).json()
    original = client.get(f"/api/export/queue/{item['id']}/file").content
    root = server.project.root
    code = """
import json, hashlib
from fastapi.testclient import TestClient
from backend.main import app
client = TestClient(app)
workspace = client.get('/api/workspace').json()
queue = client.get('/api/export/queue').json()
image = client.get('/api/export/queue/' + queue['items'][0]['id'] + '/file').content
print(json.dumps({'workspace': workspace, 'queue': queue, 'hash': hashlib.sha256(image).hexdigest()}))
"""
    env = {**os.environ, "SEISCANVAS_STATE_DIR": str(root)}
    process = subprocess.run([sys.executable, "-c", code], cwd=server.ROOT, env=env, capture_output=True, text=True, check=True)
    recovered = json.loads(process.stdout)
    assert recovered["workspace"]["state"] == state
    assert recovered["workspace"]["issues"] == []
    assert recovered["queue"]["items"][0]["filename"] == item["filename"]
    import hashlib
    assert recovered["hash"] == hashlib.sha256(original).hexdigest()
    assert Path(item["temporary_path"]).is_file()  # subprocess shutdown keeps figures


def test_uploaded_sources_survive_restart(cube):
    client = TestClient(server.app)
    with cube.path.open("rb") as stream:
        result = client.post("/api/segy", files={"file": ("upload.segy", stream)}).json()
    styles = client.post("/api/horizons", files=[("files", ("uploaded.dat", b"10 30 204\n12 33 208\n"))]).json()
    assert save(client, result, drawing_state(styles)).status_code == 200
    cube.path.unlink()
    restart()
    restored = client.get("/api/workspace").json()
    assert restored["issues"] == []
    assert restored["metadata"]["filename"] == "upload.segy"
    assert restored["horizons"][0]["name"] == "uploaded"
    assert server.survey.path.is_file()
    assert server.horizons[styles[0]["id"]].path.is_file()


def test_rename_delete_and_delayed_save_do_not_resurrect_old_horizons(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    styles, _ = import_horizons(client, tmp_path, monkeypatch)
    state = drawing_state(styles)
    assert save(client, result, state).status_code == 200
    assert client.patch(f"/api/horizons/{styles[0]['id']}", json={"name": "新名称"}).status_code == 200
    assert client.delete(f"/api/horizons/{styles[1]['id']}").status_code == 200
    assert save(client, result, state, revision=1).status_code == 200
    restart()
    restored = client.get("/api/workspace").json()
    assert [(h["id"], h["name"]) for h in restored["horizons"]] == [(styles[0]["id"], "新名称")]
    assert len(restored["state"]["view"]["horizons"]) == 1


def test_missing_source_preserves_record_and_relink_restores_it(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    state = drawing_state([])
    assert save(client, result, state).status_code == 200
    saved = server.project.path.read_bytes()
    moved = tmp_path / "moved.segy"
    shutil.move(cube.path, moved)
    restart()
    restored = client.get("/api/workspace").json()
    assert restored["metadata"] is None
    assert restored["issues"][0]["horizon_id"] is None
    assert restored["state"] == state
    assert server.project.path.read_bytes() == saved
    assert save(client, result, state, revision=1).status_code == 409
    monkeypatch.setattr(server, "choose_segy", lambda *args: str(moved))
    linked = client.post("/api/workspace/relink", json={"project_id": result["project_id"]}).json()
    assert linked["issues"] == []
    assert linked["state"] == state
    assert linked["project_id"] == result["project_id"]


def test_missing_horizon_is_preserved_until_relinked(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    styles, paths = import_horizons(client, tmp_path, monkeypatch)
    state = drawing_state(styles)
    assert save(client, result, state).status_code == 200
    moved = tmp_path / "moved.dat"
    shutil.move(paths[0], moved)
    restart()
    restored = client.get("/api/workspace").json()
    assert restored["metadata"]
    assert restored["issues"][0]["horizon_id"] == styles[0]["id"]
    # A rename of an available horizon must keep the missing source's record.
    client.patch(f"/api/horizons/{styles[1]['id']}", json={"name": "Available"})
    assert len(server.project.document["horizons"]) == 2
    monkeypatch.setattr(server, "choose_segy", lambda *args: str(moved))
    linked = client.post("/api/workspace/relink", json={"project_id": result["project_id"], "horizon_id": styles[0]["id"]}).json()
    assert linked["issues"] == []
    assert len(linked["horizons"]) == 2


def test_changed_file_is_reported_and_cancelled_relink_does_not_overwrite(cube, monkeypatch):
    client, result = open_project(cube)
    saved = server.project.path.read_bytes()
    stat = cube.path.stat()
    os.utime(cube.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    restart()
    assert "发生变化" in client.get("/api/workspace").json()["issues"][0]["message"]
    monkeypatch.setattr(server, "choose_segy", lambda *args: None)
    assert client.post("/api/workspace/relink", json={"project_id": result["project_id"]}).json() == {"cancelled": True}
    assert server.project.path.read_bytes() == saved


def test_refresh_checks_sources_even_while_backend_is_still_running(cube):
    client, result = open_project(cube)
    assert save(client, result, drawing_state([])).status_code == 200
    saved = server.project.path.read_bytes()
    cube.path.unlink()
    restored = client.get("/api/workspace").json()
    assert restored["metadata"] is None
    assert restored["issues"]
    assert server.project.path.read_bytes() == saved


def test_stale_project_and_revision_cannot_replace_newer_work(cube):
    client, first = open_project(cube)
    state = drawing_state([])
    assert save(client, first, state).status_code == 200
    assert save(client, first, state).status_code == 409
    second = client.post("/api/segy/local", json={"path": str(cube.path)}).json()
    assert second["project_id"] != first["project_id"]
    assert save(client, first, state, revision=1).status_code == 409
    assert server.project.document["state"] is None
    invalid = deepcopy(state)
    invalid["view"]["seismic"]["colormap"] = "unknown"
    assert save(client, second, invalid).status_code == 422


def test_atomic_backup_recovers_corrupt_primary_and_preserves_failed_write(tmp_path, monkeypatch):
    path = tmp_path / "save.json"
    atomic_json(path, {"state": "first"})
    atomic_json(path, {"state": "second"})
    path.write_text('{"state":')
    assert read_json(path) == {"state": "first"}
    atomic_json(path, {"state": "recovered"})
    assert json.loads(path.with_suffix(".json.bak").read_text()) == {"state": "first"}
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr("backend.storage.os.replace", fail)
    with pytest.raises(OSError):
        atomic_json(path, {"state": "lost"})
    assert read_json(path) == {"state": "recovered"}


def test_damaged_project_is_reported_without_writing_defaults(cube):
    client, _ = open_project(cube)
    server.project.path.write_text("broken")
    restart()
    response = client.get("/api/workspace")
    assert response.status_code == 400
    assert "已保留" in response.json()["detail"]
    assert server.project.path.read_text() == "broken"


def test_queue_restart_keeps_rename_deletion_serial_and_zip(client):
    body = {"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}}
    first = client.post("/api/export/queue", json=body).json()
    second = client.post("/api/export/queue", json=body).json()
    client.patch(f"/api/export/queue/{first['id']}", json={"filename": "Retained"})
    client.delete(f"/api/export/queue/{second['id']}")
    session_id = export_queue.session().id
    export_queue.shutdown()
    restored = client.get("/api/export/queue").json()
    assert restored["session"] == session_id
    assert restored["count"] == 1
    assert restored["items"][0]["filename"] == "Retained.png"
    third = client.post("/api/export/queue", json=body).json()
    assert third["id"] == "exp_0003"
    assert client.post("/api/export/archive").content.startswith(b"PK")
    client.delete("/api/export/queue")
    export_queue.shutdown()
    assert client.get("/api/export/queue").json()["count"] == 0


def test_horizon_mutations_do_not_change_live_data_when_save_fails(cube, tmp_path, monkeypatch):
    client, result = open_project(cube)
    styles, _ = import_horizons(client, tmp_path, monkeypatch)
    before = deepcopy(server.project.document)
    key = styles[0]["id"]
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(server.project, "commit", fail)
    assert client.patch(f"/api/horizons/{key}", json={"name": "Lost"}).status_code == 400
    assert server.horizons[key].name == styles[0]["name"]
    assert client.delete(f"/api/horizons/{key}").status_code == 400
    assert key in server.horizons
    response = client.post("/api/horizons", files=[("files", ("new.dat", b"10 30 204\n12 33 208\n"))])
    assert response.status_code == 400
    assert len(server.horizons) == 2
    assert server.project.document == before


def test_queue_backup_restores_latest_committed_files_after_primary_damage(client):
    body = {"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}}
    item = client.post("/api/export/queue", json=body).json()
    client.patch(f"/api/export/queue/{item['id']}", json={"filename": "Recovered"})
    folder = export_queue.session().folder
    (folder / "queue.json").write_text("broken")
    export_queue.shutdown()
    restored = client.get("/api/export/queue").json()
    assert restored["count"] == 1
    assert restored["items"][0]["filename"] == "Recovered.png"
    assert client.get(f"/api/export/queue/{item['id']}/file").content.startswith(b"\x89PNG")


@pytest.mark.parametrize("operation", ["add", "rename", "delete", "clear"])
def test_queue_failed_save_preserves_live_metadata_and_original_file(client, monkeypatch, operation):
    body = {"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}}
    item = client.post("/api/export/queue", json=body).json()
    before = deepcopy(export_queue.session().snapshot())
    data = Path(item["temporary_path"]).read_bytes()
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(export_queue.session(), "_write_manifest", fail)
    if operation == "add":
        response = client.post("/api/export/queue", json=body)
    elif operation == "rename":
        response = client.patch(f"/api/export/queue/{item['id']}", json={"filename": "Lost"})
    elif operation == "delete":
        response = client.delete(f"/api/export/queue/{item['id']}")
    else:
        response = client.delete("/api/export/queue")
    assert response.status_code == 400
    assert export_queue.session().snapshot() == before
    assert Path(item["temporary_path"]).read_bytes() == data
