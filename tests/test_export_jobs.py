"""Frozen requests, lifecycle recovery, and real process isolation for exports."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
from threading import Event
import time

import pytest

from backend.export_jobs import ExportJobManager, INTERRUPTED, _StagingSink
from backend.export_restore import make_snapshot
from backend.models import Queue2DRequest
from backend.storage import atomic_json
from backend.workspace import source


@pytest.fixture
def frozen(tmp_path):
    raw = tmp_path / "survey.segy"
    raw.write_bytes(b"source bytes")
    project_id = "a" * 32
    return {"project_id": project_id, "folder": tmp_path / "exports",
            "document": {"id": project_id, "source": source(raw, ilbyte=189, xlbyte=21, geometry_mode="auto"), "horizons": []},
            "request": {"kind": "2d", "state": {"section_number": 12, "horizons": []}, "settings": {}},
            "restore": {"version": 1, "kind": "2d", "sources": None, "request": {}}}


def thread_executor():
    return ThreadPoolExecutor(max_workers=1)


def fake_worker(path, staging):
    payload = json.loads(Path(path).read_text())
    sink = _StagingSink(staging)
    return {**sink.add(b"completed", filename="test.png", request=payload["request"]),
            "source_document": payload["document"], "timings": {"source_read_ms": 1, "render_ms": 2}}


def wait_status(manager, frozen, job_id, statuses, timeout=5):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        job = manager.get(frozen["project_id"], frozen["folder"], job_id)
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"Timed out waiting for {statuses}: {job}")


def test_freezes_request_and_publishes_to_origin_with_timings(frozen):
    running, proceed = Event(), Event()
    captured = []

    def worker(path, staging):
        running.set()
        assert proceed.wait(3)
        return fake_worker(path, staging)

    def publish(job, prepared):
        metadata = json.loads(Path(prepared["metadata_path"]).read_text())
        captured.append((job, metadata, Path(prepared["data_path"]).read_bytes()))
        return {"id": "exp_1", "filename": "test.png"}

    manager = ExportJobManager(publish, executor_factory=thread_executor, worker=worker)
    try:
        submitted = manager.submit(**frozen, timings={"snapshot_ms": 2})
        assert running.wait(3)
        frozen["request"]["state"]["section_number"] = 999
        frozen["document"]["name"] = "changed after submission"
        proceed.set()
        done = wait_status(manager, frozen, submitted["id"], {"completed"})
        assert done["item"]["id"] == "exp_1"
        assert done["timings"].keys() >= {"snapshot_ms", "queue_wait_ms", "source_read_ms", "render_ms", "publish_ms", "total_ms"}
        assert "folder" not in done and "document" not in done
        assert captured[0][0]["project_id"] == frozen["project_id"]
        assert captured[0][0]["folder"] == str(frozen["folder"])
        assert captured[0][1]["request"]["state"]["section_number"] == 12
        assert captured[0][2] == b"completed"
    finally:
        proceed.set()
        manager.shutdown()
    assert not (frozen["folder"] / ".export_jobs" / submitted["id"]).exists()
    reloaded = ExportJobManager(publish)
    assert reloaded.list(frozen["project_id"], frozen["folder"])[0]["status"] == "completed"
    reloaded.shutdown()


def test_queued_cancel_is_bounded_and_does_not_run(frozen):
    running, proceed = Event(), Event()
    calls = []

    def worker(path, staging):
        calls.append(path)
        running.set()
        assert proceed.wait(3)
        return fake_worker(path, staging)

    manager = ExportJobManager(lambda *_: {}, max_outstanding=2, executor_factory=thread_executor, worker=worker)
    try:
        first = manager.submit(**frozen)
        assert running.wait(3)
        second = manager.submit(**frozen)
        with pytest.raises(ValueError, match="最多"):
            manager.submit(**frozen)
        with pytest.raises(ValueError, match="尚未开始"):
            manager.cancel(frozen["project_id"], frozen["folder"], first["id"])
        cancelled = manager.cancel(frozen["project_id"], frozen["folder"], second["id"])
        assert cancelled["status"] == "cancelled"
        assert not (frozen["folder"] / ".export_jobs" / second["id"]).exists()
        proceed.set()
        wait_status(manager, frozen, first["id"], {"completed"})
    finally:
        proceed.set()
        manager.shutdown()
    assert len(calls) == 1


def test_failed_retry_uses_original_settings_and_identity(frozen):
    observed = []

    def worker(path, staging):
        payload = json.loads(Path(path).read_text())
        observed.append(payload)
        if len(observed) == 1:
            _StagingSink(staging).add(b"partial", filename="partial.png")
            raise ValueError("temporary render error")
        return fake_worker(path, staging)

    manager = ExportJobManager(lambda *_: {"id": "exp_1"}, executor_factory=thread_executor, worker=worker)
    try:
        job = manager.submit(**frozen)
        failed = wait_status(manager, frozen, job["id"], {"failed"})
        assert "temporary render error" in failed["error"]
        assert not (frozen["folder"] / ".export_jobs" / job["id"] / "staging").exists()
        frozen["request"]["state"]["section_number"] = 999
        retried = manager.retry(frozen["project_id"], frozen["folder"], job["id"])
        assert retried["id"] == job["id"] and retried["attempts"] == 2
        wait_status(manager, frozen, job["id"], {"completed"})
        assert observed[0] == observed[1]
    finally:
        manager.shutdown()


def test_changed_source_blocks_submission_and_retry(frozen):
    manager = ExportJobManager(lambda *_: {}, executor_factory=thread_executor,
                               worker=lambda *_: (_ for _ in ()).throw(ValueError("render failed")))
    try:
        job = manager.submit(**frozen)
        wait_status(manager, frozen, job["id"], {"failed"})
        Path(frozen["document"]["source"]["path"]).write_bytes(b"changed")
        with pytest.raises(ValueError, match="发生变化"):
            manager.retry(frozen["project_id"], frozen["folder"], job["id"])
        with pytest.raises(ValueError, match="发生变化"):
            manager.submit(**frozen)
    finally:
        manager.shutdown()


def test_restart_marks_unfinished_failed_and_cleans_staged_bytes(frozen):
    manager = ExportJobManager(lambda *_: {}, executor_factory=thread_executor,
                               worker=lambda *_: (_ for _ in ()).throw(ValueError("initial failure")))
    job = manager.submit(**frozen)
    wait_status(manager, frozen, job["id"], {"failed"})
    manager.shutdown()
    path = frozen["folder"] / ".export_jobs" / "jobs.json"
    saved = json.loads(path.read_text())
    saved["jobs"][0].update(status="running", stage="rendering")
    atomic_json(path, saved)
    stage = path.parent / job["id"] / "staging"
    stage.mkdir()
    (stage / "partial.bin").write_bytes(b"partial")
    reloaded = ExportJobManager(lambda *_: {"id": "exp_1"}, executor_factory=thread_executor, worker=fake_worker)
    try:
        interrupted = reloaded.list(frozen["project_id"], frozen["folder"])[0]
        assert interrupted["status"] == "failed" and interrupted["error"] == INTERRUPTED
        assert not stage.exists()
        reloaded.retry(frozen["project_id"], frozen["folder"], job["id"])
        wait_status(reloaded, frozen, job["id"], {"completed"})
    finally:
        reloaded.shutdown()


def test_shutdown_prevents_late_publication_and_cancels_pending(frozen):
    running, proceed = Event(), Event()
    published = []

    def worker(path, staging):
        running.set()
        assert proceed.wait(3)
        return fake_worker(path, staging)

    manager = ExportJobManager(lambda *args: published.append(args), executor_factory=thread_executor, worker=worker)
    first = manager.submit(**frozen)
    assert running.wait(3)
    second = manager.submit(**frozen)
    manager.shutdown(wait=False)
    with pytest.raises(ValueError, match="关闭"):
        manager.submit(**frozen)
    proceed.set()
    manager.shutdown()
    assert published == []
    assert manager.get(frozen["project_id"], frozen["folder"], first["id"])["status"] == "failed"
    assert manager.get(frozen["project_id"], frozen["folder"], second["id"])["status"] == "cancelled"
    assert not list((frozen["folder"] / ".export_jobs").glob("*/staging"))


def test_job_ids_cannot_cross_projects(frozen):
    manager = ExportJobManager(lambda *_: {}, executor_factory=thread_executor, worker=fake_worker)
    try:
        job = manager.submit(**frozen)
        with pytest.raises(ValueError, match="找不到"):
            manager.get("b" * 32, frozen["folder"].parent / "other", job["id"])
        wait_status(manager, frozen, job["id"], {"completed"})
    finally:
        manager.shutdown()


def test_payload_limits_and_terminal_history_pruning(frozen):
    manager = ExportJobManager(lambda *_: {}, max_payload_bytes=5)
    with pytest.raises(ValueError, match="过大"):
        manager.submit(**frozen)
    manager.shutdown()
    manager = ExportJobManager(lambda *_: {}, max_history=2, executor_factory=thread_executor,
                               worker=lambda *_: (_ for _ in ()).throw(ValueError("failed")))
    ids = []
    try:
        for _ in range(3):
            job = manager.submit(**frozen)
            ids.append(job["id"])
            wait_status(manager, frozen, job["id"], {"failed"})
        assert len(manager.list(frozen["project_id"], frozen["folder"])) == 2
        assert not (frozen["folder"] / ".export_jobs" / ids[0]).exists()
    finally:
        manager.shutdown()


def test_real_render_runs_in_separate_spawned_process(cube, tmp_path, monkeypatch):
    monkeypatch.setenv("SEISCANVAS_STATE_DIR", str(tmp_path / "worker-state"))
    req = Queue2DRequest.model_validate({"kind": "2d", "state": {"section_number": 12},
                                       "settings": {"format": "png", "canvas": "fit", "long_edge": 600,
                                                    "width": 90, "height": 60, "dpi": 300}})
    document = {"id": "c" * 32, "source": source(cube.path, ilbyte=189, xlbyte=21, geometry_mode="auto"), "horizons": []}
    frozen = {"project_id": document["id"], "folder": tmp_path / "exports", "document": document,
              "request": req.model_dump(mode="json"), "restore": make_snapshot(req, document)}
    captured = []

    def publish(job, prepared):
        captured.append(prepared)
        assert Path(prepared["data_path"]).read_bytes().startswith(b"\x89PNG")
        metadata = json.loads(Path(prepared["metadata_path"]).read_text())
        assert metadata["restore"] == frozen["restore"]
        assert prepared["source_document"] == document
        return {"id": "exp_1"}

    manager = ExportJobManager(publish)
    try:
        job = manager.submit(**frozen)
        result = wait_status(manager, frozen, job["id"], {"completed", "failed"}, timeout=30)
        assert result["status"] == "completed", result["error"]
        assert captured[0]["worker_pid"] != os.getpid()
    finally:
        manager.shutdown()


def test_pruned_cancelled_job_does_not_stop_dispatcher(frozen):
    running, proceed = Event(), Event()

    def worker(path, staging):
        running.set()
        assert proceed.wait(3)
        return fake_worker(path, staging)

    manager = ExportJobManager(lambda *_: {}, max_history=2, executor_factory=thread_executor, worker=worker)
    try:
        first = manager.submit(**frozen)
        assert running.wait(3)
        second = manager.submit(**frozen)
        manager.cancel(frozen["project_id"], frozen["folder"], second["id"])
        third = manager.submit(**frozen)
        proceed.set()
        wait_status(manager, frozen, first["id"], {"completed"})
        wait_status(manager, frozen, third["id"], {"completed"})
    finally:
        proceed.set()
        manager.shutdown()


def test_retry_save_failure_rolls_back_state(frozen, monkeypatch):
    manager = ExportJobManager(lambda *_: {}, executor_factory=thread_executor,
                               worker=lambda *_: (_ for _ in ()).throw(ValueError("render failed")))
    try:
        job = manager.submit(**frozen)
        before = wait_status(manager, frozen, job["id"], {"failed"})
        monkeypatch.setattr(manager, "_save", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
        with pytest.raises(OSError, match="disk full"):
            manager.retry(frozen["project_id"], frozen["folder"], job["id"])
        assert manager.get(frozen["project_id"], frozen["folder"], job["id"]) == before
    finally:
        manager.shutdown()


def test_cancel_save_failure_preserves_queued_job(frozen, monkeypatch):
    running, proceed = Event(), Event()

    def worker(path, staging):
        running.set()
        assert proceed.wait(3)
        return fake_worker(path, staging)

    manager = ExportJobManager(lambda *_: {}, executor_factory=thread_executor, worker=worker)
    try:
        first = manager.submit(**frozen)
        assert running.wait(3)
        second = manager.submit(**frozen)
        with monkeypatch.context() as patch:
            patch.setattr(manager, "_save", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
            with pytest.raises(OSError, match="disk full"):
                manager.cancel(frozen["project_id"], frozen["folder"], second["id"])
        assert manager.get(frozen["project_id"], frozen["folder"], second["id"])["status"] == "queued"
        assert (frozen["folder"] / ".export_jobs" / second["id"] / "input.json").is_file()
        proceed.set()
        wait_status(manager, frozen, first["id"], {"completed"})
        wait_status(manager, frozen, second["id"], {"completed"})
    finally:
        proceed.set()
        manager.shutdown()
