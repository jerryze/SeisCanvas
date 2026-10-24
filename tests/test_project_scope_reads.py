"""Read requests tolerate autosaves between guards without losing ownership checks."""
from threading import RLock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from backend import project_scope
from backend.workspace import WorkspaceStore


@pytest.fixture
def scoped_project(tmp_path, monkeypatch):
    project = WorkspaceStore(tmp_path / "scoped-read")
    project.activate(project.create("Concurrent project"))
    lock = RLock()
    monkeypatch.setattr(project_scope, "store", lambda: project)
    monkeypatch.setattr(project_scope, "lock", lock)
    return project, lock


def advance_revision(project, lock):
    # Another request commits after the reader's first guard has released the
    # lock, but before its endpoint acquires the lock again.
    with lock:
        document = project.get(project.read()["id"])
        document["revision"] += 1
        project.commit(document)


def test_read_scope_survives_intervening_autosave(scoped_project):
    project, lock = scoped_project
    identity = project_scope.RequestScope(project.read()["id"], project.epoch, None)
    token = project_scope.scope.set(identity)
    try:
        with project_scope.guarded_lock():
            original_revision = project.read()["revision"]
        assert identity.revision is None
        assert identity.result_revision == original_revision
        advance_revision(project, lock)
        with project_scope.guarded_lock():
            assert project.read()["revision"] == original_revision + 1
        assert identity.revision is None
        assert identity.result_revision == original_revision + 1
    finally:
        project_scope.scope.reset(token)


def test_explicit_mutation_revision_rejects_intervening_write(scoped_project):
    project, lock = scoped_project
    revision = project.read()["revision"]
    identity = project_scope.RequestScope(project.read()["id"], project.epoch, revision)
    token = project_scope.scope.set(identity)
    try:
        with project_scope.guarded_lock():
            pass
        advance_revision(project, lock)
        with pytest.raises(HTTPException) as conflict:
            with project_scope.guarded_lock():
                pytest.fail("A stale mutation must not execute")
        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == "REVISION_CONFLICT"
        assert identity.revision == revision
    finally:
        project_scope.scope.reset(token)


def test_mutation_can_follow_its_own_committed_revision(scoped_project):
    project, lock = scoped_project
    identity = project_scope.RequestScope(project.read()["id"], project.epoch, project.read()["revision"])
    token = project_scope.scope.set(identity)
    try:
        with project_scope.guarded_lock():
            advance_revision(project, lock)
        assert identity.revision == project.read()["revision"]
        with project_scope.guarded_lock():
            pass
    finally:
        project_scope.scope.reset(token)


@pytest.mark.parametrize("switch_project", [False, True])
def test_unversioned_read_still_rejects_changed_project_or_epoch(scoped_project, switch_project):
    project, lock = scoped_project
    identity = project_scope.RequestScope(project.read()["id"], project.epoch, None)
    token = project_scope.scope.set(identity)
    try:
        with project_scope.guarded_lock():
            pass
        with lock:
            project.activate(project.create("Different project") if switch_project else project.read())
        with pytest.raises(HTTPException) as conflict:
            with project_scope.guarded_lock():
                pytest.fail("A read from another activation must not execute")
        assert conflict.value.status_code == 409
        assert conflict.value.detail["code"] == "PROJECT_CHANGED"
    finally:
        project_scope.scope.reset(token)


def test_get_reports_new_revision_after_autosave_between_route_and_endpoint(scoped_project):
    project, lock = scoped_project
    application = FastAPI()
    application.router.route_class = project_scope.ProjectRoute

    @application.get("/api/export/jobs")
    def poll_jobs():
        # The route precheck has already completed. Inject the competing save
        # here to reproduce the polling/autosave race deterministically.
        advance_revision(project, lock)
        with project_scope.guarded_lock():
            return {"jobs": [], "revision": project.read()["revision"]}

    headers = {"X-SeisCanvas-Project": project.read()["id"], "X-SeisCanvas-Epoch": project.epoch}
    response = TestClient(application).get("/api/export/jobs", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 1
    assert response.headers["x-project-revision"] == "1"
