"""A layer-only project is durable and maps never need synthetic seismic data."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import backend.main as server
from backend import export_queue
from backend.api.exports import ExportContext, create_export_router
from backend.export_jobs import ExportJobManager
from test_workspace import drawing_state, restart, save


def import_layers(client, tmp_path):
    paths = [tmp_path / "Base_1.txt", tmp_path / "Ours_1.txt"]
    for index, path in enumerate(paths):
        path.write_text("\n".join(f"{il} {xl} {200 + il + xl + index}" for il in (10, 12) for xl in (30, 33)))
    preview = client.post("/api/horizons/pick", json={"paths": [str(p) for p in paths]})
    assert preview.status_code == 200, preview.text
    result = client.post("/api/horizons/local", json={
        "token": preview.json()["token"], "inline_column": 0, "xline_column": 1, "time_column": 2,
        "model_group": "Base", "horizon_keys": ["T24", "T24"],
    })
    assert result.status_code == 200, result.text
    return result.json()


def test_first_horizon_import_creates_durable_project_and_retains_styles(tmp_path):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    workspace = client.get("/api/workspace").json()
    assert workspace["metadata"] is None and workspace["source"] is None
    assert workspace["project_id"] and workspace["issues"] == []
    assert workspace["horizons"] == layers
    assert layers[0]["color"] == layers[1]["color"]
    state = drawing_state(layers)
    assert save(client, workspace, state).status_code == 200
    restart()
    reopened = client.get("/api/workspace").json()
    assert reopened["metadata"] is None and reopened["state"] == state
    assert reopened["project_id"] == workspace["project_id"]
    assert len(reopened["horizons"]) == 2
    assert client.get("/api/projects").json()["projects"][0]["status"] == "unchecked"


def test_upload_horizons_needs_no_segy_and_invalid_batch_is_atomic():
    client = TestClient(server.app)
    rejected = client.post("/api/horizons", files=[("files", ("valid.txt", b"10 30 200\n")),
                                                ("files", ("invalid.txt", b"not a horizon\n"))])
    assert rejected.status_code == 400
    assert not server.horizons and server.project.read() is None
    imported = client.post("/api/horizons", files=[("files", ("layer.txt", b"10 30 200\n12 33 210\n"))])
    assert imported.status_code == 200, imported.text
    assert server.project.read()["source"] is None
    assert len(server.project.read()["horizons"]) == 1


@pytest.mark.parametrize("scalar", ["twt", "difference"])
def test_map_preview_render_and_restore_without_seismic_match_loaded_volume(tmp_path, cube, scalar):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    state = {"horizon": layers[0]["id"], "color_by": scalar,
             "difference_reference": layers[0]["id"], "difference_comparison": layers[1]["id"],
             "display": "filled"}
    preview = client.post("/api/horizon-map", json=state)
    assert preview.status_code == 200, preview.text
    body = {"kind": "map", "state": state, "settings": {"format": "png", "canvas": "fit", "long_edge": 600}}
    name = client.post("/api/export/name", json=body)
    assert name.status_code == 200, name.text
    exported = client.post("/api/export/queue", json=body)
    assert exported.status_code == 200, exported.text
    item = exported.json()
    image = Path(item["temporary_path"]).read_bytes()
    assert image.startswith(b"\x89PNG") and item["filename"] == name.json()["filename"]
    url = f"/api/export/queue/{item['id']}/settings"
    restored = client.get(url)
    assert restored.status_code == 200 and restored.json()["warnings"] == []
    original_id = server.project.read()["id"]
    attached = client.post("/api/segy/local", json={"path": str(cube.path)})
    assert attached.status_code == 200, attached.text
    assert attached.json()["project_id"] == original_id
    assert client.post("/api/horizon-map", json=state).json() == preview.json()
    repeated = client.post("/api/export/queue", json=body)
    assert repeated.status_code == 200, repeated.text
    assert Path(repeated.json()["temporary_path"]).read_bytes() == image
    # Maps depend on layer sources only, so attaching seismic keeps restoration valid.
    assert client.get(url).json() == restored.json()


def test_first_segy_keeps_horizon_project_map_state_and_initializes_sections(tmp_path, cube):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    workspace = client.get("/api/workspace").json()
    state = drawing_state(layers)
    state["view"]["section_number"] = -99
    state["view"]["slices"] = {"inline": [], "crossline": [], "time": []}
    assert save(client, workspace, state).status_code == 200
    attached = client.post("/api/segy/local", json={"path": str(cube.path)}).json()
    assert attached["project_id"] == workspace["project_id"]
    assert attached["name"] == workspace["name"]
    assert attached["state"]["map"] == state["map"]
    view = attached["state"]["view"]
    assert view["horizons"] == state["view"]["horizons"]
    assert view["scene"] == state["view"]["scene"]
    assert view["section_number"] == 12 and view["view_type"] == "inline"
    assert view["x_range"] is None and view["time_range"] is None
    assert [view["slices"][kind][0]["position"] for kind in ("inline", "crossline", "time")] == [12, 33, 208]
    assert all(view["slices"][kind][0]["border"] == {"visible": True, "color": "#000000", "width": 1}
               for kind in ("inline", "crossline", "time"))
    restart()
    reopened = client.get("/api/workspace").json()
    assert reopened["state"] == attached["state"] and reopened["metadata"] is not None


def test_amplitude_requests_reject_without_segy(tmp_path):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    state = {"horizon": layers[0]["id"], "color_by": "amplitude"}
    requests = [
        ("/api/horizon-map", state),
        ("/api/export/name", {"kind": "map", "state": state, "settings": {}}),
        ("/api/export/jobs", {"kind": "map", "state": state, "settings": {}}),
    ]
    for path, request in requests:
        response = client.post(path, json=request)
        assert response.status_code == 400, (path, response.text)
        assert "SEG-Y" in response.text


def test_background_map_export_works_without_survey_reads(tmp_path, monkeypatch):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    context = ExportContext(require_survey=server.require_survey, get_survey=lambda: None,
                            get_horizons=lambda: server.horizons, get_project=lambda: server.project,
                            project_lock=server.lock)
    router = create_export_router(context, manager_factory=lambda publish: ExportJobManager(
        publish, executor_factory=lambda: ThreadPoolExecutor(max_workers=1)))
    app = FastAPI()
    app.include_router(router)
    export_client = TestClient(app)
    body = {"kind": "map", "state": {"horizon": layers[0]["id"]},
            "settings": {"format": "png", "canvas": "fit", "long_edge": 600}}
    def no_survey(*args, **kwargs):
        raise AssertionError("Layer-only maps must not open a seismic volume")
    monkeypatch.setattr("backend.segy.Survey", no_survey)
    try:
        submitted = export_client.post("/api/export/jobs", json=body)
        assert submitted.status_code == 202, submitted.text
        job = submitted.json()
        until = time.monotonic() + 10
        while time.monotonic() < until:
            job = export_client.get(f"/api/export/jobs/{job['id']}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(.01)
        assert job["status"] == "completed", job
        assert job["item"]["filename"] == "层位图_Base_1.png"
        snapshot = export_queue.session().restore_item(job["item"]["id"])["restore"]
        assert set(snapshot["sources"]) == {f"horizon:{layers[0]['id']}"}
    finally:
        router.export_jobs.shutdown()
