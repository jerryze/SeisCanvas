"""Every figure type is exportable from real picks without a seismic source."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

import backend.main as server
from backend import export_queue
from backend.api.exports import ExportContext, create_export_router
from backend.export_jobs import ExportJobManager
from test_export_restore import request_for
from test_horizon_only import import_layers


def layer_request(kind, layers, fmt="png"):
    body = request_for(kind)
    body["settings"]["format"] = fmt
    if kind == "3d":
        body["format"] = fmt
    if kind in ("2d", "3d"):
        body["state"]["horizons"] = deepcopy(layers)
        body["state"].pop("x_range", None)
        body["state"].pop("time_range", None)
    else:
        body["state"]["horizon"] = layers[0]["id"]
        body["horizons"] = deepcopy(layers)
        body.pop("x_range", None)
        body.pop("time_range", None)
    return body


@pytest.mark.parametrize("kind", ["2d", "3d", "map", "profile"])
@pytest.mark.parametrize("fmt", ["png", "pdf", "svg"])
def test_all_horizon_figures_name_export_restore_and_preserve_bytes(tmp_path, kind, fmt):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    body = layer_request(kind, layers, fmt)
    named = client.post("/api/export/name", json=body)
    assert named.status_code == 200, named.text
    result = client.post("/api/export/queue", json=body)
    assert result.status_code == 200, result.text
    item = result.json()
    assert item["filename"] == named.json()["filename"]
    original = Path(item["temporary_path"]).read_bytes()
    assert original and (original.startswith(b"\x89PNG") if fmt == "png" else original.startswith(b"%PDF") if fmt == "pdf" else b"<svg" in original)
    restored = client.get(f"/api/export/queue/{item['id']}/settings")
    assert restored.status_code == 200, restored.text
    assert restored.json()["kind"] == kind and not restored.json()["warnings"]
    stored = export_queue.session().restore_item(item["id"])
    assert "survey" not in stored["restore"]["sources"]
    if kind == "2d":
        assert stored["summary"]["colorbar_range"] is None
    if kind == "profile":
        assert stored["summary"]["amplitude_range"] is None
    repeated = client.post("/api/export/queue", json=body)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["filename"].endswith(f"_02.{fmt}")
    if fmt == "png":
        assert Path(repeated.json()["temporary_path"]).read_bytes() == original
    assert Path(item["temporary_path"]).read_bytes() == original


@pytest.mark.parametrize("kind", ["2d", "3d", "map", "profile"])
def test_horizon_only_background_jobs_never_open_segy(tmp_path, monkeypatch, kind):
    client = TestClient(server.app)
    layers = import_layers(client, tmp_path)
    context = ExportContext(require_survey=server.require_survey, get_survey=lambda: None,
        get_horizons=lambda: server.horizons, get_project=lambda: server.project, project_lock=server.lock)
    router = create_export_router(context, manager_factory=lambda publish: ExportJobManager(
        publish, executor_factory=lambda: ThreadPoolExecutor(max_workers=1)))
    app = FastAPI()
    app.include_router(router)
    api = TestClient(app)
    def no_seismic(*args, **kwargs):
        raise AssertionError("Horizon-only figures must not read SEG-Y")
    monkeypatch.setattr("backend.segy.Survey", no_seismic)
    try:
        result = api.post("/api/export/jobs", json=layer_request(kind, layers))
        assert result.status_code == 202, result.text
        job = result.json()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = api.get(f"/api/export/jobs/{job['id']}").json()
            if job["status"] in {"completed", "failed"}:
                break
            time.sleep(.01)
        assert job["status"] == "completed", job
        assert Path(job["item"]["temporary_path"]).is_file()
    finally:
        router.export_jobs.shutdown()
