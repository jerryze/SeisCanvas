"""Project library actions address the selected project without activating it."""
from copy import deepcopy

import pytest

import backend.main as server
from backend.storage import atomic_json
from backend.workspace import WorkspaceStore
from test_projects import activate, create, identity, prepare
from test_workspace import drawing_state, open_project, restart, save


def test_rename_inactive_project_preserves_active_identity_and_revision(cube):
    client, current = open_project(cube)
    other = create(client, "待整理", template_id=current["project_id"])
    prepared = prepare(client, other).json()["token"]
    before, epoch, survey = deepcopy(server.project.read()), server.project.epoch, server.survey
    renamed = client.patch(f"/api/projects/{other}", json={"name": "已整理"}, headers=identity(current))
    assert renamed.status_code == 200, renamed.text
    assert server.project.get(other)["name"] == "已整理"
    assert server.project.read() == before and server.project.epoch == epoch and server.survey is survey
    assert renamed.headers["X-Project-Revision"] == str(before["revision"])
    # A switch prepared against the old target must be retried, not silently applied.
    assert client.post(f"/api/project-switches/{prepared}/commit").status_code == 409
    assert activate(client, other)["name"] == "已整理"


def test_copy_inactive_project_uses_selected_settings_not_current(cube):
    client, source = open_project(cube)
    layers = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n12 33 208\n"))]).json()
    state = drawing_state(layers)
    state["dataset"] = "待复制项目的设置"
    assert save(client, source, state).status_code == 200
    other = create(client, "当前空项目")
    current = activate(client, other)
    clone = create(client, "所选项目的副本", template_id=source["project_id"])
    assert server.project.read()["id"] == other
    copied = activate(client, clone)
    assert copied["state"] == state and copied["horizons"][0]["id"] == layers[0]["id"]
    assert client.get("/api/export/queue").json()["count"] == 0
    assert server.project.get(clone)["source"] == server.project.get(source["project_id"])["source"]
    assert activate(client, current["project_id"])["horizons"] == []


def test_close_preserves_project_data_and_rejects_old_requests(cube):
    client, current = open_project(cube)
    state = drawing_state([])
    assert save(client, current, state).status_code == 200
    before = deepcopy(server.project.read())
    pid = current["project_id"]
    result = client.post(f"/api/projects/{pid}/close", headers=identity(current))
    assert result.status_code == 200, result.text
    assert result.json()["project_id"] is None and result.json()["horizons"] == []
    assert result.json()["activation_epoch"] != current["activation_epoch"]
    assert server.survey is None and server.horizons == {}
    assert server.project.get(pid) == before and not server.project.is_deleted(pid)
    assert client.get("/api/export/queue").json()["count"] == 0
    assert client.patch(f"/api/projects/{pid}", json={"name": "旧页面"}, headers=identity(current)).status_code == 409
    restart()
    assert client.get("/api/workspace").json()["project_id"] is None
    assert {p["id"] for p in client.get("/api/projects").json()["projects"]} == {pid}
    assert activate(client, pid)["state"] == state


def test_close_rejects_inactive_target(cube):
    client, current = open_project(cube)
    other = create(client)
    epoch = server.project.epoch
    assert client.post(f"/api/projects/{other}/close").status_code == 409
    assert server.project.read()["id"] == current["project_id"] and server.project.epoch == epoch


def test_failed_close_keeps_current_project(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path)
    current = store.activate(store.create("项目"))
    epoch = store.epoch
    original = atomic_json
    def reject_index(path, value, **kw):
        if path.name == "projects.json":
            raise OSError("disk full")
        return original(path, value, **kw)
    monkeypatch.setattr("backend.workspace.atomic_json", reject_index)
    with pytest.raises(OSError):
        store.close()
    assert store.read() == current and store.epoch == epoch
    assert WorkspaceStore(tmp_path).read()["id"] == current["id"]
