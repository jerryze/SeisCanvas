"""Durable, bounded export jobs rendered in one isolated worker process.

Only frozen source references and request JSON cross the process boundary. The
worker never binds a project or writes its figure queue. ``publish`` runs in the
server process and is responsible for registering the staged result in the
origin project's queue under the application's project lock.
"""
from __future__ import annotations

from collections import deque
from concurrent.futures import ProcessPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
import logging
import multiprocessing
import os
from pathlib import Path
import re
import shutil
from threading import Condition, Lock, Thread
from time import perf_counter
from types import SimpleNamespace
from uuid import uuid4

from backend.storage import atomic_json, read_json

LOG = logging.getLogger(__name__)
TERMINAL = {"completed", "failed", "cancelled"}
INTERRUPTED = "应用已关闭或重启，导出未完成。可重试以继续使用提交时的设置。"


def _now():
    return datetime.now(timezone.utc).isoformat()


def validate_sources(document, request, restore=None):
    """Check the frozen files, including default-all A–B profile overlays."""
    from backend.export_restore import dependencies, source_signatures
    from backend.workspace import check_source

    if not document.get("source"):
        raise ValueError("后台导出需要已保存的数据来源，请重新打开数据后再试。")
    check_source(document["source"])
    ids = dependencies(request["kind"], request)
    entries = {h["id"]: h for h in document.get("horizons", [])}
    if ids - entries.keys():
        raise ValueError("图件所需层位的数据来源缺失，无法后台导出。")
    signatures = source_signatures(document, ids)
    expected = (restore or {}).get("sources")
    if expected is not None and signatures != expected:
        raise ValueError("图件的源数据或解析参数已变化，请重新提交导出。")
    if request["kind"] == "profile" and request.get("horizons") is None:
        for entry in entries.values():
            check_source(entry)
        ids.update(entries)
    return ids


def _check_sources(payload):
    return validate_sources(payload["document"], payload["request"], payload.get("restore"))


class _StagingSink:
    def __init__(self, folder):
        self.folder = Path(folder)

    def add(self, data, **metadata):
        # Never derive a filesystem path from a requested output filename.
        self.folder.mkdir(parents=True, exist_ok=True)
        data_path = self.folder / "figure.bin"
        data_path.write_bytes(data)
        metadata_path = self.folder / "metadata.json"
        atomic_json(metadata_path, metadata, backup=False)
        return {"data_path": str(data_path), "metadata_path": str(metadata_path)}


def prepare_export(payload_path, staging_folder):
    """Process entry point; returns small file references, never image bytes.

    ``source_read_ms`` measures source/index reconstruction. Amplitude sampling
    performed by the renderer is included in ``render_ms``.
    """
    from backend import export_service
    from backend.horizon import Horizon
    from backend.models import Queue2DRequest, Queue3DRequest, QueueMapRequest, QueueProfileRequest
    from backend.segy import Survey

    staging = Path(staging_folder)
    staging.mkdir(parents=True, exist_ok=True)
    progress_path = staging / "progress.json"
    atomic_json(progress_path, {"stage": "reading"}, backup=False)
    payload = json.loads(Path(payload_path).read_text(encoding="utf-8"))
    request, document = payload["request"], payload["document"]
    models = {"2d": Queue2DRequest, "3d": Queue3DRequest, "map": QueueMapRequest, "profile": QueueProfileRequest}
    req = models[request["kind"]].model_validate(request)
    started = perf_counter()
    ids = _check_sources(payload)
    entry = document["source"]
    if req.kind == "3d":
        # The browser has already rendered the exact scene. Only its dataset
        # filename is needed; re-reading SEG-Y would waste memory and time.
        survey = SimpleNamespace(path=Path(entry["path"]))
        horizons = {}
    else:
        survey = Survey(entry["path"], ilbyte=entry["ilbyte"], xlbyte=entry["xlbyte"],
                        geometry_mode=entry["geometry_mode"])
        horizons = {h["id"]: Horizon(h["path"], name=h["name"], columns=h["columns"])
                    for h in document.get("horizons", []) if h["id"] in ids}
    timings = {"source_read_ms": (perf_counter() - started) * 1000}
    atomic_json(progress_path, {"stage": "rendering", "timings": timings}, backup=False)
    phase = perf_counter()
    sink = _StagingSink(staging)
    kwargs = {"restore": payload["restore"], "sink": sink}
    if req.kind == "3d":
        prepared = export_service.add_3d(survey, req, **kwargs)
    else:
        render = {"2d": export_service.add_2d, "map": export_service.add_map,
                  "profile": export_service.add_profile}[req.kind]
        prepared = render(survey, horizons, req, **kwargs)
    timings["render_ms"] = (perf_counter() - phase) * 1000
    _check_sources(payload)
    return {**prepared, "timings": timings, "worker_pid": os.getpid(), "source_document": document}


class ExportJobManager:
    def __init__(self, publish, *, max_outstanding=8, max_payload_bytes=200 * 1024 * 1024,
                 max_total_payload_bytes=512 * 1024 * 1024, max_history=80,
                 executor_factory=None, worker=prepare_export):
        self._publish = publish
        self._max_outstanding = max_outstanding
        self._max_payload_bytes = max_payload_bytes
        self._max_total_payload_bytes = max_total_payload_bytes
        self._max_history = max_history
        self._executor_factory = executor_factory or (lambda: ProcessPoolExecutor(
            max_workers=1, mp_context=multiprocessing.get_context("spawn")))
        self._worker = worker
        self._condition = Condition()
        # No application callback executes while _condition is held. The gate
        # prevents shutdown racing with publication without lock inversion.
        self._publish_gate = Lock()
        self._projects = {}
        self._pending = deque()
        self._accepting = True
        self._thread = None
        self._executor = None

    def _load(self, project_id, folder):
        if not isinstance(project_id, str) or not re.fullmatch(r"[a-f0-9]{32}", project_id):
            raise ValueError("无效的项目 ID。")
        folder = Path(folder).resolve()
        if project_id in self._projects:
            project = self._projects[project_id]
            if project["folder"] != folder:
                raise ValueError("导出任务的项目目录已变化。")
            return project
        root = folder / ".export_jobs"
        path = root / "jobs.json"
        saved = read_json(path) or {"version": 1, "project_id": project_id, "jobs": []}
        if saved.get("version") != 1 or saved.get("project_id") != project_id or not isinstance(saved.get("jobs"), list):
            raise ValueError("后台导出任务记录损坏。")
        jobs = {}
        for job in saved["jobs"]:
            if (not isinstance(job, dict) or not re.fullmatch(r"[a-f0-9]{32}", job.get("id", ""))
                    or job.get("project_id") != project_id
                    or job.get("status") not in TERMINAL | {"queued", "running"}):
                raise ValueError("后台导出任务记录损坏。")
            # The directory supplied by the trusted caller is authoritative;
            # persisted metadata cannot redirect a publication to another path.
            job["folder"] = str(folder)
            if job["status"] in {"queued", "running"}:
                job.update(status="failed", stage="failed", error=INTERRUPTED, updated_at=_now())
            jobs[job["id"]] = job
        project = {"id": project_id, "folder": folder, "root": root, "path": path, "jobs": jobs}
        self._projects[project_id] = project
        # Stages are disposable. The frozen input is retained only for retryable
        # failures. Also remove abandoned inputs from interrupted submissions.
        if root.exists():
            for child in root.iterdir():
                if child.is_dir() and re.fullmatch(r"[a-f0-9]{32}", child.name):
                    shutil.rmtree(child / "staging", ignore_errors=True)
                    if child.name not in jobs or jobs[child.name]["status"] in {"completed", "cancelled"}:
                        shutil.rmtree(child, ignore_errors=True)
            self._save(project)
        return project

    @staticmethod
    def _save(project):
        atomic_json(project["path"], {"version": 1, "project_id": project["id"],
                    "jobs": list(project["jobs"].values())})

    @staticmethod
    def _payload_path(project, job):
        return project["root"] / job["id"] / "input.json"

    def _public(self, project, job):
        result = {key: deepcopy(value) for key, value in job.items() if key not in {"folder", "queued_at"}}
        if job["status"] == "running":
            progress = read_json(project["root"] / job["id"] / "staging" / "progress.json")
            if progress and job["stage"] != "writing":
                result["stage"] = progress.get("stage", result["stage"])
                result["timings"].update(progress.get("timings", {}))
        return result

    def _capacity(self):
        active = sum(j["status"] in {"queued", "running"}
                     for p in self._projects.values() for j in p["jobs"].values())
        if active >= self._max_outstanding:
            raise ValueError(f"后台导出最多同时保留 {self._max_outstanding} 个待处理任务，请稍后再试。")

    def _require_accepting(self):
        if not self._accepting:
            raise ValueError("后台导出正在关闭，请重新打开应用后再试。")

    def _enqueue(self, project, job):
        self._save(project)
        self._pending.append((job["project_id"], job["id"]))
        if self._thread is None:
            self._thread = Thread(target=self._run, name="seiscanvas-export-dispatch", daemon=True)
            self._thread.start()
        self._condition.notify_all()

    def submit(self, *, project_id, folder, document, request, restore, timings=None):
        if document.get("id") != project_id:
            raise ValueError("导出任务与项目不匹配。")
        if request.get("kind") not in {"2d", "3d", "map", "profile"}:
            raise ValueError("不支持的导出类型。")
        payload = {"document": document, "request": request, "restore": restore}
        # Encoding also takes a deep snapshot of caller-owned dictionaries.
        encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        if len(encoded) > self._max_payload_bytes:
            raise ValueError("此图件的导出数据过大，请降低三维捕获分辨率。")
        _check_sources(payload)
        with self._condition:
            self._require_accepting()
            project = self._load(project_id, folder)
            self._capacity()
            payload_bytes = sum(path.stat().st_size for path in project["root"].glob("*/input.json"))
            # Bound status history as well as retained failed inputs. Reclaim
            # oldest terminal history before refusing a new request, so a large
            # failed capture cannot permanently fill the staging allowance.
            while (len(project["jobs"]) >= self._max_history
                   or payload_bytes + len(encoded) > self._max_total_payload_bytes):
                oldest = next((j for j in project["jobs"].values() if j["status"] in TERMINAL), None)
                if oldest is None:
                    raise ValueError("后台导出暂存空间或任务列表已满，请完成或取消排队任务后重试。")
                previous = self._payload_path(project, oldest)
                if previous.is_file():
                    payload_bytes -= previous.stat().st_size
                shutil.rmtree(project["root"] / oldest["id"], ignore_errors=True)
                del project["jobs"][oldest["id"]]
            now = _now()
            kind = request["kind"]
            label = {"2d": "二维剖面", "3d": "三维场景", "map": "层位地图", "profile": "A–B 剖面"}[kind]
            if kind == "2d":
                state = request["state"]
                label += f" · {'Inline' if state.get('view_type', 'inline') == 'inline' else 'Crossline'} {state.get('section_number', '')}"
            job = {"id": uuid4().hex, "project_id": project_id, "folder": str(project["folder"]),
                   "kind": kind, "status": "queued", "stage": "queued", "label": label,
                   "error": None, "item": None, "created_at": now, "updated_at": now,
                   "queued_at": now, "attempts": 1, "timings": deepcopy(timings or {})}
            path = self._payload_path(project, job)
            path.parent.mkdir(parents=True, exist_ok=False)
            try:
                with path.open("xb") as stream:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                project["jobs"][job["id"]] = job
                self._enqueue(project, job)
            except Exception:
                project["jobs"].pop(job["id"], None)
                shutil.rmtree(path.parent, ignore_errors=True)
                raise
            return self._public(project, job)

    def list(self, project_id, folder):
        with self._condition:
            project = self._load(project_id, folder)
            return [self._public(project, job) for job in reversed(list(project["jobs"].values()))]

    def get(self, project_id, folder, job_id):
        with self._condition:
            project, job = self._find(project_id, folder, job_id)
            return self._public(project, job)

    def _find(self, project_id, folder, job_id):
        project = self._load(project_id, folder)
        job = project["jobs"].get(job_id)
        if job is None:
            raise ValueError("找不到此后台导出任务。")
        return project, job

    def cancel(self, project_id, folder, job_id):
        with self._condition:
            project, job = self._find(project_id, folder, job_id)
            if job["status"] != "queued":
                raise ValueError("仅能取消尚未开始的导出任务。")
            previous = deepcopy(job)
            job.update(status="cancelled", stage="cancelled", updated_at=_now())
            try:
                self._save(project)
            except Exception:
                job.clear()
                job.update(previous)
                raise
            self._pending = deque(pair for pair in self._pending if pair != (project_id, job_id))
            shutil.rmtree(project["root"] / job_id, ignore_errors=True)
            self._condition.notify_all()
            return self._public(project, job)

    def retry(self, project_id, folder, job_id):
        with self._condition:
            self._require_accepting()
            project, job = self._find(project_id, folder, job_id)
            if job["status"] != "failed":
                raise ValueError("仅能重试失败的导出任务。")
            self._capacity()
            path = self._payload_path(project, job)
            if not path.is_file():
                raise ValueError("此任务的原始设置已清理，请重新提交导出。")
            payload = json.loads(path.read_text(encoding="utf-8"))
            _check_sources(payload)
            now = _now()
            previous = deepcopy(job)
            job.update(status="queued", stage="queued", error=None, item=None, updated_at=now,
                       queued_at=now, attempts=job["attempts"] + 1, timings={})
            try:
                self._enqueue(project, job)
            except Exception:
                job.clear()
                job.update(previous)
                self._pending = deque(pair for pair in self._pending if pair != (project_id, job_id))
                raise
            return self._public(project, job)

    def _run(self):
        while True:
            with self._condition:
                self._condition.wait_for(lambda: self._pending or not self._accepting)
                if not self._accepting:
                    break
                project_id, job_id = self._pending.popleft()
                project = self._projects[project_id]
                job = project["jobs"].get(job_id)
                if job is None or job["status"] != "queued":
                    continue
                started = perf_counter()
                wait_ms = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(job["queued_at"])).total_seconds() * 1000)
                job["timings"]["queue_wait_ms"] = wait_ms
                job.update(status="running", stage="reading", updated_at=_now())
                try:
                    self._save(project)
                except Exception as exc:
                    job.update(status="failed", stage="failed", error=str(exc), updated_at=_now())
                    LOG.exception("Unable to save export job start")
                    continue
                staging = project["root"] / job_id / "staging"
            try:
                if self._executor is None:
                    self._executor = self._executor_factory()
                prepared = self._executor.submit(self._worker, str(self._payload_path(project, job)), str(staging)).result()
                with self._condition:
                    job["timings"].update(prepared.get("timings", {}))
                    job["stage"] = "writing"
                with self._publish_gate:
                    with self._condition:
                        if not self._accepting:
                            raise ValueError(INTERRUPTED)
                        publication = deepcopy(job)
                    # The parent callback takes its own project lock and must
                    # be idempotent for this immutable job ID.
                    phase = perf_counter()
                    item = self._publish(publication, prepared)
                    with self._condition:
                        job["timings"]["publish_ms"] = (perf_counter() - phase) * 1000
                        job.update(status="completed", stage="completed", item=item, error=None)
            except Exception as exc:
                LOG.exception("Export job %s failed", job_id)
                with self._condition:
                    job.update(status="failed", stage="failed", error=str(exc) or type(exc).__name__)
                # A dead worker must not poison all later submissions/retries.
                from concurrent.futures.process import BrokenProcessPool
                if isinstance(exc, BrokenProcessPool) and self._executor is not None:
                    self._executor.shutdown(wait=False, cancel_futures=True)
                    self._executor = None
            finally:
                shutil.rmtree(staging, ignore_errors=True)
                with self._condition:
                    job["timings"]["total_ms"] = wait_ms + (perf_counter() - started) * 1000
                    job["updated_at"] = _now()
                    persisted = False
                    try:
                        self._save(project)
                        persisted = True
                    except Exception:
                        LOG.exception("Unable to persist export job result")
                    if job["status"] == "completed" and persisted:
                        shutil.rmtree(project["root"] / job_id, ignore_errors=True)
                    self._condition.notify_all()
        if self._executor is not None:
            self._executor.shutdown(wait=True, cancel_futures=True)
            self._executor = None

    def shutdown(self, wait=True):
        with self._publish_gate:
            with self._condition:
                self._accepting = False
                for project in self._projects.values():
                    changed = False
                    for job in project["jobs"].values():
                        if job["status"] == "queued":
                            job.update(status="cancelled", stage="cancelled", error=None, updated_at=_now())
                            shutil.rmtree(project["root"] / job["id"], ignore_errors=True)
                            changed = True
                    if changed:
                        try:
                            self._save(project)
                        except Exception:
                            LOG.exception("Unable to persist export shutdown")
                self._pending.clear()
                self._condition.notify_all()
        if wait and self._thread is not None:
            self._thread.join()
