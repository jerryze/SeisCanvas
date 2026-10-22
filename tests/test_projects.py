"""Multi-project isolation, reference-only saving, and transactional switching."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
from threading import Event
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

import backend.main as server
from backend import export_queue
from backend.storage import atomic_json
from backend.workspace import WorkspaceStore, source
from test_workspace import drawing_state, open_project, save, restart


def create(client, name="Project B", **extra):
    r = client.post("/api/projects", json={"name": name, **extra})
    assert r.status_code == 200, r.text
    return r.json()["project_id"]


def prepare(client, target):
    current = server.project.read()
    return client.post("/api/project-switches", json={"target_id": target, "source_revision": current["revision"] if current else None})


def activate(client, target):
    r = prepare(client, target)
    assert r.status_code == 200, r.text
    r = client.post(f"/api/project-switches/{r.json()['token']}/commit")
    assert r.status_code == 200, r.text
    return r.json()


def identity(result):
    return {"X-SeisCanvas-Project": result["project_id"], "X-SeisCanvas-Epoch": result["activation_epoch"]}


def test_empty_project_save_reload_and_first_import_keep_identity(cube):
    client = TestClient(server.app)
    pid = create(client, "空白项目")
    empty = activate(client, pid)
    assert empty["metadata"] is None and empty["horizons"] == []
    assert save(client, empty, drawing_state([])).status_code == 200
    restart()
    assert client.get("/api/workspace").json()["project_id"] == pid
    loaded = client.post("/api/segy/local", json={"path": str(cube.path)}).json()
    assert loaded["project_id"] == pid
    assert loaded["name"] == "空白项目"
    assert loaded["metadata"]["filename"] == "tiny.segy"


def test_round_trip_restores_independent_settings_without_source_copies(cube):
    client, a = open_project(cube)
    state_a = drawing_state([])
    state_a.update(dataset="工区 A", sidebarValues={"2d:数据": False}, sidebarScroll={"2d": 125})
    assert save(client, a, state_a).status_code == 200
    pid_b = create(client)
    assert server.project.read()["id"] == a["project_id"]
    b = activate(client, pid_b)
    loaded_b = client.post("/api/segy/local", json={"path": str(cube.path)}).json()
    assert loaded_b["project_id"] == pid_b
    state_b = drawing_state([])
    state_b["dataset"] = "独立项目 B"
    state_b["view"]["seismic"]["colormap"] = "seismic"
    assert save(client, b, state_b).status_code == 200
    assert activate(client, a["project_id"])["state"] == state_a
    assert activate(client, pid_b)["state"] == state_b
    assert list(server.project.root.rglob("*.segy")) == []
    assert server.project.get(a["project_id"])["source"]["path"] == str(cube.path)
    restart()
    assert client.get("/api/workspace").json()["state"] == state_b
    assert len(client.get("/api/projects").json()["projects"]) == 2


def test_clone_shares_sources_but_layer_registry_and_exports_are_independent(cube, tmp_path):
    client, a = open_project(cube)
    layers = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n12 33 208\n"))]).json()
    assert save(client, a, drawing_state(layers)).status_code == 200
    assets = sorted(str(p) for p in (server.project.root / "assets").rglob("*") if p.is_file())
    added = client.post("/api/export/queue", json={"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}})
    assert added.status_code == 200, added.text
    pid = create(client, "副本", template_id=a["project_id"])
    b = activate(client, pid)
    assert b["state"]["view"]["scene"] == drawing_state(layers)["view"]["scene"]
    assert client.get("/api/export/queue").json()["count"] == 0
    assert client.patch(f"/api/horizons/{layers[0]['id']}", json={"name": "B 独立名称"}).status_code == 200
    assert client.delete(f"/api/horizons/{layers[0]['id']}").status_code == 200
    restored = activate(client, a["project_id"])
    assert restored["horizons"][0]["name"] == "h"
    assert client.get("/api/export/queue").json()["count"] == 1
    assert sorted(str(p) for p in (server.project.root / "assets").rglob("*") if p.is_file()) == assets


def test_export_files_and_queue_operations_remain_bound_to_their_project(cube):
    client, a = open_project(cube)
    body = {"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png"}}
    item_a = client.post("/api/export/queue", json=body).json()
    content_a = client.get(f"/api/export/queue/{item_a['id']}/file?project_id={a['project_id']}").content
    pid = create(client, template_id=a["project_id"])
    activate(client, pid)
    assert client.get("/api/export/queue").json()["count"] == 0
    item_b = client.post("/api/export/queue", json=body).json()
    assert item_b["id"] == item_a["id"]  # IDs are local to each queue.
    client.delete("/api/export/queue")
    assert Path(item_a["temporary_path"]).is_file()
    assert client.get(f"/api/export/queue/{item_a['id']}/file?project_id={a['project_id']}").content == content_a
    assert client.get(f"/api/export/queue/{item_b['id']}/file?project_id={pid}").status_code == 404
    activate(client, a["project_id"])
    assert client.get("/api/export/queue").json()["count"] == 1


@pytest.mark.parametrize("path,method,payload", [
    ("/api/section", "POST", {"section_number": 12}),
    ("/api/export/queue", "DELETE", None),
    ("/api/horizons/nonexistent", "DELETE", None),
    ("/api/segy/local", "POST", {"path": "/tmp/irrelevant.segy"}),
])
def test_stale_tab_requests_cannot_read_or_mutate_another_project(cube, path, method, payload):
    client, a = open_project(cube)
    old = identity(a)
    pid = create(client)
    activate(client, pid)
    r = client.request(method, path, json=payload, headers=old)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "PROJECT_CHANGED"
    assert server.project.read()["id"] == pid
    # Even switching back to the same project never revives an old activation.
    activate(client, a["project_id"])
    assert client.request(method, path, json=payload, headers=old).status_code == 409


def test_project_identity_is_required_for_non_bootstrap_requests(cube):
    client, _ = open_project(cube)
    r = client.send(client.build_request("DELETE", "/api/export/queue"))
    assert r.status_code == 428


def test_preparing_or_cancelling_never_changes_active_context(cube):
    client, a = open_project(cube)
    original = server.survey
    pid = create(client)
    token = prepare(client, pid).json()["token"]
    assert server.survey is original
    assert server.project.read()["id"] == a["project_id"]
    assert client.delete(f"/api/project-switches/{token}").status_code == 200
    assert client.post(f"/api/project-switches/{token}/commit").status_code == 409
    assert server.survey is original


def test_switch_rejects_a_revision_changed_during_preparation(cube):
    client, a = open_project(cube)
    pid = create(client)
    token = prepare(client, pid).json()["token"]
    assert save(client, a, drawing_state([])).status_code == 200
    r = client.post(f"/api/project-switches/{token}/commit")
    assert r.status_code == 409
    assert server.project.read()["id"] == a["project_id"]


def test_missing_target_source_keeps_current_project_and_saved_target(cube):
    client, a = open_project(cube)
    pid = create(client, template_id=a["project_id"])
    path = server.project.project_path(pid)
    target = json.loads(path.read_text())
    target["source"]["path"] += ".missing"
    atomic_json(path, target)
    before = path.read_bytes()
    current = server.survey
    r = prepare(client, pid)
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "SOURCE_ISSUES"
    assert server.survey is current
    assert server.project.read()["id"] == a["project_id"]
    assert path.read_bytes() == before


def test_failed_activation_write_keeps_previous_context(cube, monkeypatch):
    client, a = open_project(cube)
    pid = create(client)
    token = prepare(client, pid).json()["token"]
    original = server.survey
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr("backend.workspace.atomic_json", fail)
    assert client.post(f"/api/project-switches/{token}/commit").status_code == 400
    assert server.survey is original
    assert server.project.read()["id"] == a["project_id"]


def test_delayed_import_cannot_commit_into_newly_active_project(cube, monkeypatch):
    client, a = open_project(cube)
    pid = create(client)
    started, release = Event(), Event()
    original = server.Survey
    def slow(*args, **kwargs):
        started.set()
        assert release.wait(10)
        return original(*args, **kwargs)
    monkeypatch.setattr(server, "Survey", slow)
    with ThreadPoolExecutor() as pool:
        pending = pool.submit(client.post, "/api/segy/local", json={"path": str(cube.path)})
        assert started.wait(5)
        activate(client, pid)
        release.set()
        assert pending.result().status_code == 409
    assert server.project.read()["id"] == pid
    assert server.project.read()["source"] is None
    assert server.project.get(a["project_id"])["source"]["path"] == str(cube.path)


def test_create_is_idempotent_and_names_cannot_be_used_as_paths(cube):
    client, _ = open_project(cube)
    request_id = uuid4().hex
    pid = create(client, "同名项目", request_id=request_id)
    assert create(client, "同名项目", request_id=request_id) == pid
    assert create(client, "同名项目") != pid
    assert client.post("/api/projects", json={"name": "  "}).status_code == 400
    assert client.post("/api/projects", json={"name": "bad\nname"}).status_code == 400
    assert client.post("/api/projects", json={"name": "x", "request_id": "../escape"}).status_code == 422


def test_source_relink_requires_preview_confirmation_and_target_revision(cube, monkeypatch):
    client, a = open_project(cube)
    pid = create(client, template_id=a["project_id"])
    monkeypatch.setattr(server, "choose_segy", lambda *a: str(cube.path))
    before = server.project.project_path(pid).read_bytes()
    preview = client.post(f"/api/projects/{pid}/relink", json={}).json()
    assert preview["metadata"]["traces"] == 6
    assert server.project.project_path(pid).read_bytes() == before
    stale = client.post(f"/api/projects/{pid}/relink", json={"confirm": True, "path": preview["path"], "revision": 99, "file_identity": preview["file_identity"]})
    assert stale.status_code == 409
    r = client.post(f"/api/projects/{pid}/relink", json={"confirm": True, "path": preview["path"], "revision": preview["revision"], "file_identity": preview["file_identity"]})
    assert r.status_code == 200
    assert server.project.read()["id"] == a["project_id"]
    assert server.project.get(pid)["revision"] == 1


def test_legacy_migration_keeps_original_files_and_queue_without_copying(cube, tmp_path):
    root = tmp_path / "legacy"
    pid = uuid4().hex
    legacy = {"version": 1, "id": pid, "revision": 7, "source": source(cube.path, ilbyte=189, xlbyte=21, geometry_mode="auto"), "horizons": [], "state": drawing_state([]), "updated_at": "2026-10-21T00:00:00+00:00"}
    atomic_json(root / "workspace.json", legacy)
    old_queue = export_queue.ExportSession(root / "exports" / "session_old")
    store = WorkspaceStore(root)
    restored = store.read()
    assert restored["id"] == pid and restored["revision"] == 7
    assert restored["legacy_exports"] == str(old_queue.folder)
    assert restored["source"]["path"] == str(cube.path)
    assert (root / "workspace.json").is_file()
    assert list(root.rglob("*.segy")) == []
    assert WorkspaceStore(root).read()["id"] == pid
    assert len(list((root / "projects").iterdir())) == 1


def test_project_index_can_be_rebuilt_without_touching_project_documents(cube):
    client, a = open_project(cube)
    pid = create(client)
    documents = {p: p.read_bytes() for p in server.project.root.glob("projects/*/project.json")}
    (server.project.root / "projects.json").write_text("broken")
    (server.project.root / "projects.json.bak").unlink(missing_ok=True)
    store = WorkspaceStore(server.project.root)
    result = store.list()
    assert {p["id"] for p in result["projects"]} == {a["project_id"], pid}
    assert all(p.read_bytes() == content for p, content in documents.items())


def test_completed_switch_can_be_retried_with_its_original_identity(cube):
    client, a = open_project(cube)
    pid = create(client)
    token = prepare(client, pid).json()["token"]
    headers = {**identity(a), "X-SeisCanvas-Revision": str(server.project.read()["revision"])}
    first = client.post(f"/api/project-switches/{token}/commit", headers=headers)
    second = client.post(f"/api/project-switches/{token}/commit", headers=headers)
    assert first.status_code == second.status_code == 200
    assert first.json()["activation_epoch"] == second.json()["activation_epoch"]
    assert second.json()["project_id"] == pid


def test_target_file_changed_after_prepare_cannot_be_activated(cube):
    import os
    client, a = open_project(cube)
    pid = create(client, template_id=a["project_id"])
    token = prepare(client, pid).json()["token"]
    stat = cube.path.stat()
    os.utime(cube.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
    response = client.post(f"/api/project-switches/{token}/commit")
    assert response.status_code == 400
    assert server.project.read()["id"] == a["project_id"]


def test_config_mutations_require_a_revision_as_well_as_identity(cube):
    client, a = open_project(cube)
    response = client.send(client.build_request("PATCH", f"/api/projects/{a['project_id']}", json={"name": "stale"}, headers=identity(a)))
    assert response.status_code == 428
    assert server.project.read()["name"] != "stale"


def test_incomplete_state_cannot_replace_a_valid_project(cube):
    client, a = open_project(cube)
    original = server.project.path.read_bytes()
    r = client.put("/api/workspace", json={"project_id": a["project_id"], "revision": 0, "state": {"version": 1}})
    assert r.status_code == 422
    assert server.project.path.read_bytes() == original


def test_source_changed_between_relink_preview_and_confirmation_is_rejected(cube, monkeypatch):
    import os
    client, a = open_project(cube)
    pid = create(client, template_id=a["project_id"])
    monkeypatch.setattr(server, "choose_segy", lambda *a: str(cube.path))
    preview = client.post(f"/api/projects/{pid}/relink", json={}).json()
    original = server.project.project_path(pid).read_bytes()
    stat = cube.path.stat()
    os.utime(cube.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
    response = client.post(f"/api/projects/{pid}/relink", json={"confirm": True, "path": preview["path"], "revision": preview["revision"], "file_identity": preview["file_identity"]})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "SOURCE_CHANGED"
    assert server.project.project_path(pid).read_bytes() == original


def test_damaged_legacy_file_does_not_prevent_explicit_project_creation(tmp_path, monkeypatch):
    root = tmp_path / "damaged-legacy"
    root.mkdir()
    (root / "workspace.json").write_text("broken legacy file")
    monkeypatch.setattr(server, "project", WorkspaceStore(root))
    client = TestClient(server.app)
    assert client.get("/api/workspace").status_code == 400
    pid = create(client, "新的独立项目")
    assert activate(client, pid)["project_id"] == pid
    assert (root / "workspace.json").read_text() == "broken legacy file"
