"""Background export API keeps project ownership and figure restoration intact."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event, RLock
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend import export_queue, project_scope
from backend.api import exports
from backend.export_jobs import ExportJobManager, prepare_export
from backend.workspace import WorkspaceStore, source
from test_export_restore import request_for


@dataclass
class Gate:
    started: Event = field(default_factory=Event)
    proceed: Event = field(default_factory=Event)
    after_render: bool = False

    def worker(self, path, staging):
        prepared = prepare_export(path, staging) if self.after_render else None
        self.started.set()
        if not self.proceed.wait(10):
            raise RuntimeError("test worker gate timed out")
        return prepared if prepared is not None else prepare_export(path, staging)


@pytest.fixture
def job_api(cube, horizon, tmp_path, monkeypatch):
    project = WorkspaceStore(tmp_path / "job-api")
    template = {"source": source(cube.path, ilbyte=189, xlbyte=21, geometry_mode="auto"),
                "horizons": [source(horizon.path, id="isolated", name=horizon.name,
                                    columns=list(horizon.columns), style={})], "state": None}
    document = project.activate(project.create("Project A", template=template))
    lock = RLock()
    monkeypatch.setattr(project_scope, "store", lambda: project)
    monkeypatch.setattr(project_scope, "lock", lock)
    horizons = {"isolated": horizon}
    context = exports.ExportContext(require_survey=lambda: cube, get_horizons=lambda: horizons,
                                    get_project=lambda: project, project_lock=lock)
    gate = Gate()
    router = exports.create_export_router(context, manager_factory=lambda publish: ExportJobManager(
        publish, executor_factory=lambda: ThreadPoolExecutor(max_workers=1), worker=gate.worker))
    application = FastAPI()
    application.router.route_class = project_scope.ProjectRoute
    application.include_router(router)

    @application.post("/api/section")
    def section_probe():
        with project_scope.guarded_lock():
            coords, times, values = cube.section("inline", 12)
            return {"traces": len(coords), "samples": len(times)}

    def headers():
        current = project.read()
        return {"X-SeisCanvas-Project": current["id"], "X-SeisCanvas-Epoch": project.epoch,
                "X-SeisCanvas-Revision": str(current["revision"])}

    state = {"client": TestClient(application), "manager": router.export_jobs, "project": project,
             "gate": gate, "headers": headers, "context": context, "horizons": horizons,
             "origin": document, "template": template, "lock": lock}
    yield state
    gate.proceed.set()
    router.export_jobs.shutdown()


def completed(state, job_id, expected="completed", timeout=10):
    client, headers = state["client"], state["headers"]
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        response = client.get(f"/api/export/jobs/{job_id}", headers=headers())
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in {"completed", "failed", "cancelled"}:
            assert job["status"] == expected, job
            return job
        time.sleep(0.01)
    raise AssertionError(f"Job did not complete: {job}")


def test_submission_returns_before_worker_and_section_reads_continue(job_api):
    state = job_api
    started = time.monotonic()
    submitted = state["client"].post("/api/export/jobs", headers=state["headers"](), json=request_for("2d"))
    assert submitted.status_code == 202, submitted.text
    assert time.monotonic() - started < 1
    assert state["gate"].started.wait(3)
    assert not state["gate"].proceed.is_set()
    read = state["client"].post("/api/section", headers=state["headers"](), json={})
    assert read.status_code == 200 and read.json() == {"traces": 3, "samples": 4}
    assert "submit_ms" in submitted.headers["server-timing"]
    assert "lock_wait_ms" in read.headers["server-timing"]
    assert state["client"].get("/api/export/queue", headers=state["headers"]()).json()["count"] == 0
    state["gate"].proceed.set()
    job = completed(state, submitted.json()["id"])
    assert job["timings"]["snapshot_ms"] >= 0
    assert state["client"].get("/api/export/queue", headers=state["headers"]()).json()["count"] == 1


def test_origin_project_receives_result_after_switch(job_api):
    state = job_api
    client, project = state["client"], state["project"]
    headers_a = state["headers"]()
    submission = client.post("/api/export/jobs", headers=headers_a, json=request_for("2d"))
    assert submission.status_code == 202, submission.text
    job_id = submission.json()["id"]
    assert state["gate"].started.wait(3)
    origin_folder = project.export_folder()
    with state["lock"]:
        project.activate(project.create("Project B", template=state["template"]))
        export_queue.bind(project.export_folder())
    assert client.get("/api/export/jobs", headers=state["headers"]()).json()["jobs"] == []
    assert client.get(f"/api/export/jobs/{job_id}", headers=state["headers"]()).status_code == 400
    assert client.get("/api/export/jobs", headers=headers_a).status_code == 409
    # Prime B's in-memory queue before A completes, to detect accidental binds.
    queue_b = client.get("/api/export/queue", headers=state["headers"]()).json()
    assert queue_b["count"] == 0
    state["gate"].proceed.set()
    until = time.monotonic() + 10
    while time.monotonic() < until:
        job = state["manager"].get(state["origin"]["id"], origin_folder, job_id)
        if job["status"] in {"completed", "failed"}:
            break
        time.sleep(0.01)
    assert job["status"] == "completed", job
    assert client.get("/api/export/queue", headers=state["headers"]()).json()["count"] == 0
    assert len(export_queue.ExportSession.load(origin_folder).items) == 1
    assert Path(job["item"]["temporary_path"]).is_relative_to(origin_folder)
    preview = client.get(f"/api/export/queue/{job['item']['id']}/file?project_id={state['origin']['id']}")
    assert preview.status_code == 200 and preview.content.startswith(b"\x89PNG")


def test_publication_preserves_cached_queue_edits_and_is_idempotent(job_api, monkeypatch):
    state = job_api
    client = state["client"]
    existing = client.post("/api/export/queue", headers=state["headers"](), json=request_for("2d")).json()
    original_publish = exports.publish_export
    duplicate_results = []

    def twice(context, job, prepared):
        first = original_publish(context, job, prepared)
        duplicate_results.append(original_publish(context, job, prepared))
        return first

    monkeypatch.setattr(exports, "publish_export", twice)
    submitted = client.post("/api/export/jobs", headers=state["headers"](), json=request_for("2d"))
    assert submitted.status_code == 202, submitted.text
    assert state["gate"].started.wait(3)
    renamed = client.patch(f"/api/export/queue/{existing['id']}", headers=state["headers"](),
                           json={"filename": "User-renamed"})
    assert renamed.status_code == 200
    state["gate"].proceed.set()
    job = completed(state, submitted.json()["id"])
    queue = client.get("/api/export/queue", headers=state["headers"]()).json()
    assert queue["count"] == 2
    assert queue["items"][0]["filename"] == "User-renamed.png"
    assert duplicate_results[0]["id"] == job["item"]["id"]
    persisted = export_queue.ExportSession.load(state["project"].export_folder())
    assert len(persisted.items) == 2
    assert persisted.items[1]["summary"]["export_job_id"] == job["id"]


def test_source_change_after_render_is_rejected_before_publication(job_api):
    state = job_api
    state["gate"].after_render = True
    submitted = state["client"].post("/api/export/jobs", headers=state["headers"](), json=request_for("2d"))
    assert submitted.status_code == 202, submitted.text
    assert state["gate"].started.wait(5)
    path = Path(state["origin"]["source"]["path"])
    path.write_bytes(path.read_bytes() + b"changed after render")
    state["gate"].proceed.set()
    job = completed(state, submitted.json()["id"], expected="failed")
    assert "发生变化" in job["error"]
    queue = state["client"].get("/api/export/queue", headers=state["headers"]()).json()
    assert queue["count"] == 0
    assert not list(state["project"].export_folder().glob(".export_jobs/*/staging"))


def test_removing_current_horizon_does_not_change_frozen_export(job_api):
    state = job_api
    submitted = state["client"].post("/api/export/jobs", headers=state["headers"](), json=request_for("2d"))
    assert submitted.status_code == 202, submitted.text
    assert state["gate"].started.wait(3)
    with state["lock"]:
        state["project"].update_horizons([])
        state["horizons"].clear()
    state["gate"].proceed.set()
    job = completed(state, submitted.json()["id"])
    item = export_queue.ExportSession.load(state["project"].export_folder()).items[0]
    assert item["restore"]["request"]["state"]["horizons"][0]["id"] == "isolated"
    assert item["id"] == job["item"]["id"]


@pytest.mark.parametrize("kind", ["2d", "3d", "map", "profile"])
def test_background_exports_keep_all_four_restore_snapshots(job_api, kind):
    state = job_api
    state["gate"].proceed.set()
    body = request_for(kind)
    submitted = state["client"].post("/api/export/jobs", headers=state["headers"](), json=body)
    assert submitted.status_code == 202, submitted.text
    job = completed(state, submitted.json()["id"])
    restored = state["client"].get(f"/api/export/queue/{job['item']['id']}/settings", headers=state["headers"]())
    assert restored.status_code == 200, restored.text
    payload = restored.json()
    assert payload["kind"] == kind and payload["warnings"] == []
    assert payload["request"]["settings"]["height"] == 100
    assert "png" not in payload["request"]
    assert job["kind"] == kind and job["item"]["restorable"]


def test_jobs_routes_enforce_revision_and_cancel_only_queued(job_api):
    state = job_api
    client = state["client"]
    stale = {**state["headers"](), "X-SeisCanvas-Revision": "999"}
    rejected = client.post("/api/export/jobs", headers=stale, json=request_for("2d"))
    assert rejected.status_code == 409
    first = client.post("/api/export/jobs", headers=state["headers"](), json=request_for("2d")).json()
    assert state["gate"].started.wait(3)
    second = client.post("/api/export/jobs", headers=state["headers"](), json=request_for("2d")).json()
    assert client.post(f"/api/export/jobs/{first['id']}/cancel", headers=state["headers"]()).status_code == 400
    cancelled = client.post(f"/api/export/jobs/{second['id']}/cancel", headers=state["headers"]())
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "cancelled"
    state["gate"].proceed.set()
    completed(state, first["id"])
