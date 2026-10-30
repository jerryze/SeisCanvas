"""Recoverable project deletion preserves data and fences stale work."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

from fastapi.testclient import TestClient
import pytest

import backend.main as server
from backend import export_queue
from backend.export_jobs import ExportJobManager
from backend.storage import atomic_json
from backend.workspace import WorkspaceStore
from test_projects import create, activate, identity, prepare
from test_workspace import open_project, drawing_state, save, restart
from test_export_jobs import fake_worker, wait_status


def project_ids(client, deleted=False):
    return {p["id"] for p in client.get(f"/api/projects?deleted={str(deleted).lower()}").json()["projects"]}


def test_delete_active_restore_preserves_sources_styles_and_figure_bytes(cube):
    client, original = open_project(cube)
    pid = original["project_id"]
    layers = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n12 33 208\n"))]).json()
    state = drawing_state(layers)
    assert save(client, original, state).status_code == 200
    item = client.post("/api/export/queue", json={"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png", "long_edge": 600}}).json()
    data_paths = [cube.path, Path(server.project.read()["horizons"][0]["path"]), Path(item["temporary_path"])]
    data = {p: p.read_bytes() for p in data_paths}
    stale = {**identity(original), "X-SeisCanvas-Revision": str(server.project.read()["revision"])}
    other = create(client, "另存为副本", template_id=pid)
    result = client.delete(f"/api/projects/{pid}")
    assert result.status_code == 200, result.text
    empty = result.json()["workspace"]
    assert empty["project_id"] is None and empty["horizons"] == [] and empty["metadata"] is None
    assert empty["activation_epoch"] != original["activation_epoch"]
    assert server.survey is None and server.horizons == {}
    assert client.get("/api/export/queue").json()["count"] == 0
    assert project_ids(client) == {other} and project_ids(client, True) == {pid}
    assert prepare(client, pid).status_code == 400
    assert client.get(f"/api/export/queue/{item['id']}/file?project_id={pid}").status_code == 404
    assert client.delete(f"/api/projects/{other}", headers=stale).status_code == 409
    assert client.put("/api/workspace", headers=stale, json={"project_id": pid, "revision": 0, "state": state}).status_code == 409
    restart()
    assert client.get("/api/workspace").json()["project_id"] is None
    assert project_ids(client, True) == {pid}
    assert client.post(f"/api/projects/{pid}/restore").status_code == 200
    assert client.post(f"/api/projects/{pid}/restore").status_code == 200
    assert client.get("/api/workspace").json()["project_id"] is None
    restored = activate(client, pid)
    assert restored["state"] == state
    assert client.get("/api/export/queue").json()["count"] == 1
    assert {p: p.read_bytes() for p in data_paths} == data
    # Shared uploaded sources continue to work in the clone as well.
    assert activate(client, other)["horizons"][0]["id"] == layers[0]["id"]


def test_delete_inactive_invalidates_prepared_switch_but_keeps_current(cube):
    client, current = open_project(cube)
    pid = create(client)
    token = prepare(client, pid).json()["token"]
    survey, epoch, revision = server.survey, server.project.epoch, server.project.read()["revision"]
    assert client.delete(f"/api/projects/{pid}").json()["workspace"] is None
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert server.survey is survey and server.project.epoch == epoch
    assert server.project.read()["revision"] == revision
    assert client.post(f"/api/project-switches/{token}/commit").status_code == 409
    assert client.get("/api/workspace").json()["project_id"] == current["project_id"]
    assert client.post(f"/api/projects/{pid}/restore").status_code == 200
    assert server.survey is survey and server.project.epoch == epoch


@pytest.mark.parametrize("damaged", [False, True])
def test_missing_or_damaged_project_can_be_deleted_and_restored(cube, damaged):
    client, current = open_project(cube)
    pid = create(client, template_id=current["project_id"])
    path = server.project.project_path(pid)
    if damaged:
        path.write_text("broken configuration")
    else:
        document = server.project.get(pid)
        document["source"]["path"] += ".missing"
        atomic_json(path, document)
    before = path.read_bytes()
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert pid not in project_ids(client) and pid in project_ids(client, True)
    assert client.post(f"/api/projects/{pid}/restore").status_code == 200
    assert path.read_bytes() == before and pid in project_ids(client)
    assert prepare(client, pid).status_code in {400, 422}


def test_failed_delete_keeps_active_state_and_restart_ignores_deleted_index(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path)
    document = store.activate(store.create("项目"))
    pid, epoch = document["id"], store.epoch
    original_write = atomic_json
    def reject_index(path, value, **kw):
        if path.name == "projects.json":
            raise OSError("disk full")
        return original_write(path, value, **kw)
    monkeypatch.setattr("backend.workspace.atomic_json", reject_index)
    with pytest.raises(OSError):
        store.delete(pid)
    assert not store.is_deleted(pid) and store.read()["id"] == pid and store.epoch == epoch
    # Simulate process exit between marker and index update.
    original_write(store.deleted_path(pid), {"id": pid})
    restarted = WorkspaceStore(tmp_path)
    assert restarted.read() is None
    assert restarted.list()["projects"] == []
    assert restarted.list(deleted=True)["projects"][0]["id"] == pid


def test_deleted_document_cannot_be_resurrected_by_a_late_write(tmp_path):
    store = WorkspaceStore(tmp_path)
    original = store.activate(store.create("项目"))
    store.delete(original["id"])
    for operation in (store.write, store.activate):
        with pytest.raises(ValueError, match="已删除"):
            operation(original)
    for bad_id in ("../outside", "", "a" * 31, "a" * 33):
        with pytest.raises(ValueError):
            store.delete(bad_id)
        with pytest.raises(ValueError):
            store.restore_deleted(bad_id)


def test_deleting_last_project_invalidates_old_empty_tab():
    client = TestClient(server.app)
    old_empty = client.get("/api/workspace").json()
    pid = create(client)
    activate(client, pid)
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    stale = {"X-SeisCanvas-Project": "none", "X-SeisCanvas-Epoch": old_empty["activation_epoch"]}
    assert client.post(f"/api/projects/{pid}/restore", headers=stale).status_code == 409
    assert project_ids(client, True) == {pid}


def test_active_export_prevents_delete_without_touching_other_projects(cube, monkeypatch):
    client, current = open_project(cube)
    pid = current["project_id"]
    started, proceed = Event(), Event()
    def worker(path, staging):
        started.set()
        assert proceed.wait(10)
        return fake_worker(path, staging)
    manager = ExportJobManager(lambda *_: {"id": "exp_1"}, executor_factory=lambda: ThreadPoolExecutor(max_workers=1), worker=worker)
    monkeypatch.setattr(server.export_router, "export_jobs", manager)
    frozen = {"project_id": pid, "folder": server.project.export_folder(), "document": server.project.get(pid),
              "request": {"kind": "2d", "state": {"section_number": 12}, "settings": {}}, "restore": {}}
    try:
        job = manager.submit(**frozen)
        assert started.wait(5)
        result = client.delete(f"/api/projects/{pid}")
        assert result.status_code == 409 and result.json()["detail"]["code"] == "PROJECT_BUSY"
        assert not server.project.is_deleted(pid)
        other = create(client)
        assert client.delete(f"/api/projects/{other}").status_code == 200
        proceed.set()
        wait_status(manager, frozen, job["id"], {"completed"})
        assert client.delete(f"/api/projects/{pid}").status_code == 200
    finally:
        proceed.set()
        manager.shutdown()
