"""Permanent removal is scoped to a trashed project's own files and is retryable."""
from copy import deepcopy
from pathlib import Path
import shutil

import pytest

import backend.main as server
from backend.storage import atomic_json, read_json
from backend.workspace import WorkspaceStore
from test_project_delete import project_ids
from test_projects import activate, create
from test_workspace import drawing_state, open_project, restart, save


def test_purge_removes_config_and_figures_but_preserves_shared_sources(cube):
    client, original = open_project(cube)
    pid = original["project_id"]
    layers = client.post("/api/horizons", files=[("files", ("h.txt", b"10 30 204\n12 33 208\n"))]).json()
    state = drawing_state(layers)
    assert save(client, original, state).status_code == 200
    document = deepcopy(server.project.read())
    item = client.post("/api/export/queue", json={"kind": "2d", "state": {"section_number": 12}, "settings": {"format": "png", "long_edge": 600}}).json()
    paths = [cube.path, Path(document["horizons"][0]["path"])]
    before = {p: p.read_bytes() for p in paths}
    clone = create(client, "共享数据的副本", template_id=pid)
    current = activate(client, clone)
    epoch, revision, survey = server.project.epoch, server.project.read()["revision"], server.survey
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    response = client.delete(f"/api/projects/{pid}/permanent")
    assert response.status_code == 200, response.text
    assert not server.project.project_path(pid).parent.exists()
    assert not Path(item["temporary_path"]).exists()
    assert {p: p.read_bytes() for p in paths} == before
    assert project_ids(client) == {clone} and project_ids(client, True) == set()
    assert client.post(f"/api/projects/{pid}/restore").status_code == 400
    assert server.project.read()["id"] == current["project_id"]
    assert server.project.epoch == epoch and server.project.read()["revision"] == revision and server.survey is survey
    assert client.delete(f"/api/projects/{pid}/permanent").status_code == 200
    for operation in (server.project.write, server.project.activate):
        with pytest.raises(ValueError):
            operation(document)
    with pytest.raises(ValueError):
        server.project.create("旧请求重放", request_id=pid)
    assert read_json(server.project.purged_path(pid)) == {"complete": True}
    restart()
    assert project_ids(client) == {clone} and project_ids(client, True) == set()
    assert activate(client, clone)["horizons"][0]["id"] == layers[0]["id"]


def test_purge_only_accepts_trashed_projects_and_rejects_bad_ids(tmp_path):
    store = WorkspaceStore(tmp_path)
    original = store.activate(store.create("打开中的项目"))
    other = store.create("未打开项目")
    for document in (original, other):
        with pytest.raises(ValueError, match="最近删除"):
            store.purge(document["id"])
        assert store.project_path(document["id"]).exists()
    for project_id in ("../outside", "", "a" * 31, "a" * 33):
        with pytest.raises(ValueError):
            store.purge(project_id)


def test_partial_cleanup_stays_visible_as_nonrestorable_and_retries_after_restart(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path)
    document = store.create("待彻底删除")
    pid = document["id"]
    store.delete(pid)
    folder = store.project_path(pid).parent
    original_rmtree = shutil.rmtree
    def partial_delete(path):
        (path / "project.json").unlink()
        raise OSError("file is busy")
    with monkeypatch.context() as patch:
        patch.setattr("backend.workspace.shutil.rmtree", partial_delete)
        with pytest.raises(OSError):
            store.purge(pid)
    assert folder.exists()
    restarted = WorkspaceStore(tmp_path)
    assert restarted.list()["projects"] == []
    entry = restarted.list(deleted=True)["projects"][0]
    assert entry["id"] == pid and entry["name"] == "待彻底删除" and entry["status"] == "purging"
    with pytest.raises(ValueError, match="无法恢复"):
        restarted.restore_deleted(pid)
    restarted.purge(pid)
    assert not folder.exists() and restarted.list(deleted=True)["projects"] == []
    assert shutil.rmtree is original_rmtree


def test_marker_failure_does_not_remove_any_project_files(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path)
    pid = store.create("保留项目")["id"]
    store.delete(pid)
    before = store.project_path(pid).read_bytes()
    original = atomic_json
    def reject_marker(path, value, **kw):
        if path.parent.name == "purged":
            raise OSError("disk full")
        return original(path, value, **kw)
    monkeypatch.setattr("backend.workspace.atomic_json", reject_marker)
    with pytest.raises(OSError):
        store.purge(pid)
    assert store.project_path(pid).read_bytes() == before
    store.restore_deleted(pid)
    assert store.get(pid)["name"] == "保留项目"


def test_purge_damaged_document_and_does_not_follow_symlink(tmp_path):
    store = WorkspaceStore(tmp_path / "app")
    pid = store.create("损坏项目")["id"]
    store.delete(pid)
    path = store.project_path(pid)
    path.write_text("broken config")
    external = tmp_path / "original-data"
    external.mkdir()
    source = external / "horizon.txt"
    source.write_text("original scientific data")
    (path.parent / "linked-data").symlink_to(external, target_is_directory=True)
    store.purge(pid)
    assert source.read_text() == "original scientific data"


def test_purge_rejects_symlinked_project_directory(tmp_path):
    store = WorkspaceStore(tmp_path / "app")
    pid = store.create("项目")["id"]
    store.delete(pid)
    folder = store.project_path(pid).parent
    external = tmp_path / "external"
    folder.rename(external)
    folder.symlink_to(external, target_is_directory=True)
    with pytest.raises(ValueError, match="目录异常"):
        store.purge(pid)
    assert (external / "project.json").exists()


def test_legacy_export_folder_is_removed_only_after_last_project_reference(tmp_path):
    store = WorkspaceStore(tmp_path)
    folder = tmp_path / "exports" / "session_legacy"
    folder.mkdir(parents=True)
    (folder / "figure.png").write_bytes(b"figure")
    projects = [store.create("旧项目 A"), store.create("旧项目 B")]
    for document in projects:
        document["legacy_exports"] = str(folder)
        store.write(document)
    store.delete(projects[0]["id"])
    store.purge(projects[0]["id"])
    assert (folder / "figure.png").exists()
    store.delete(projects[1]["id"])
    store.purge(projects[1]["id"])
    assert not folder.exists()
