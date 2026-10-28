"""Figure downloads and persistent export queues, independent of app globals."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
import json
from pathlib import Path
from time import perf_counter
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from matplotlib import font_manager
from starlette.types import Receive, Scope, Send

from backend import export_queue, naming
from backend.export3d import package_scene
from backend.export_jobs import ExportJobManager, validate_sources
from backend.export_restore import make_snapshot, restore_payload, requires_seismic
from backend.export_service import add_2d, add_3d, add_map, add_profile, export_name
from backend.horizon import Horizon
from backend.horizon_geometry import HorizonGeometry
from backend.horizon_map import render_map
from backend.models import (
    ExportRequest, HorizonMapExport, QueueAddRequest, QueueArchiveRequest,
    RenameRequest, SceneExportRequest, ExportNameRequest,
)
from backend.project_scope import ProjectRoute, guarded_lock, scope as request_scope
from backend.rendering import render
from backend.segy import Survey
from backend.workspace import WorkspaceStore


@dataclass(frozen=True)
class ExportContext:
    """Resolve live application state only while a request owns its lock."""
    require_survey: Callable[[], Survey]
    get_horizons: Callable[[], Mapping[str, Horizon]]
    get_project: Callable[[], WorkspaceStore]
    project_lock: AbstractContextManager
    get_survey: Callable[[], Survey | None] | None = None


class ArchiveResponse(FileResponse):
    """Each download owns its ZIP, including when sending is interrupted."""
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


def _error(error):
    return HTTPException(400, str(error))


def publish_export(context: ExportContext, job: dict, prepared: dict) -> dict:
    """Commit one staged result to its origin, without rebinding the active queue."""
    # Large reads belong outside the application lock. Queue insertion and its
    # authoritative manifest commit remain one short, rollback-safe transaction.
    data = Path(prepared["data_path"]).read_bytes()
    metadata = json.loads(Path(prepared["metadata_path"]).read_text(encoding="utf-8"))
    with context.project_lock:
        project = context.get_project()
        document = project.get(job["project_id"])
        folder = project.export_folder(document)
        if folder.resolve() != Path(job["folder"]).resolve():
            raise ValueError("原项目的导出目录已变化，请重新提交图件。")
        queue = export_queue.queue_for_folder(folder)
        # A crash after queue commit but before job status persistence must not
        # duplicate the figure on retry.
        existing = next((item for item in queue.items
                         if item["summary"].get("export_job_id") == job["id"]), None)
        if existing is not None:
            return queue.public(existing)
        restore = metadata["restore"]
        validate_sources(prepared["source_document"], restore["request"], restore)
        metadata["summary"]["export_job_id"] = job["id"]
        return queue.add(data=data, **metadata)


def create_export_router(context: ExportContext, *, manager_factory=ExportJobManager) -> APIRouter:
    router = APIRouter(route_class=ProjectRoute)
    jobs = manager_factory(lambda job, prepared: publish_export(context, job, prepared))
    router.export_jobs = jobs

    def origin():
        with guarded_lock():
            project = context.get_project()
            document = project.read()
            if not document:
                raise HTTPException(400, "请先打开项目再导出图件。")
            return document, project.export_folder(document)

    def map_survey(state):
        if state.color_by == "amplitude" or context.get_survey is None:
            return context.require_survey()
        return context.get_survey()

    def display_geometry():
        survey = context.get_survey() if context.get_survey is not None else context.require_survey()
        return survey if survey is not None else HorizonGeometry(context.get_horizons())

    def request_survey(req):
        if requires_seismic(req.model_dump()):
            return context.require_survey()
        if req.kind == "map" and req.profile is None:
            return map_survey(req.state)
        return display_geometry()

    def available_export_name(req, document, folder):
        filename = export_name(request_survey(req), context.get_horizons(), req)
        taken = [item["filename"] for item in export_queue.queue_for_folder(folder).items]
        taken.extend(job["filename"] for job in jobs.list(document["id"], folder)
                     if job["status"] in {"queued", "running"} and job.get("filename"))
        return naming.unique_name(filename, taken)

    @router.post("/api/export/map-name")
    @router.post("/api/export/name")
    def preview_export_name(req: ExportNameRequest):
        try:
            with guarded_lock():
                project = context.get_project()
                document = project.read()
                if not document:
                    raise ValueError("请先打开项目再保存图件。")
                return {"filename": available_export_name(req, document, project.export_folder(document))}
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.post("/api/export/jobs", status_code=202)
    def submit_export(req: QueueAddRequest):
        started = perf_counter()
        try:
            with guarded_lock():
                request_survey(req)
                project = context.get_project()
                document = project.read()
                if not document:
                    raise ValueError("请先打开项目再导出图件。")
                folder = project.export_folder(document)
                # Reserve the same name for all figure kinds, including queued
                # jobs. No rendering or 3D capture is needed for name previews.
                req = req.model_copy(update={"filename": available_export_name(req, document, folder)})
                snapshot = make_snapshot(req, document)
                job = jobs.submit(project_id=document["id"], folder=folder,
                    document=document, request=req.model_dump(mode="json"), restore=snapshot,
                    timings={"snapshot_ms": (perf_counter() - started) * 1000})
            identity = request_scope.get()
            if identity:
                identity.timings["submit_ms"] = (perf_counter() - started) * 1000
            return job
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.get("/api/export/jobs")
    def list_exports():
        try:
            # Empty workspaces also mount the queue panel.
            with guarded_lock():
                project = context.get_project()
                document = project.read()
                if not document:
                    return {"jobs": []}
                folder = project.export_folder(document)
            return {"jobs": jobs.list(document["id"], folder)}
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.get("/api/export/jobs/{job_id}")
    def get_export(job_id: str):
        try:
            document, folder = origin()
            return jobs.get(document["id"], folder, job_id)
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.post("/api/export/jobs/{job_id}/cancel")
    def cancel_export(job_id: str):
        try:
            document, folder = origin()
            return jobs.cancel(document["id"], folder, job_id)
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.post("/api/export/jobs/{job_id}/retry")
    def retry_export(job_id: str):
        try:
            document, folder = origin()
            return jobs.retry(document["id"], folder, job_id)
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.post("/api/horizon-map/export")
    def horizon_map_export(req: HorizonMapExport):
        with guarded_lock():
            horizons = context.get_horizons()
            if req.state.horizon not in horizons:
                raise HTTPException(404, "Horizon not found.")
            try:
                survey = context.require_survey() if req.state.color_by == "amplitude" else (
                    display_geometry() if req.profile is not None else map_survey(req.state))
                content = render_map(survey, horizons[req.state.horizon],
                                     req.state, req.settings, horizons, req.profile)
                return Response(content, media_type=export_queue.MIME[req.settings.format])
            except ValueError as error:
                raise _error(error)

    @router.post("/api/export")
    def export(req: ExportRequest):
        try:
            with guarded_lock():
                data = render(display_geometry(), context.get_horizons(), req.state, req.settings)
            fmt = req.settings.format
            return Response(
                data,
                media_type=export_queue.MIME[fmt],
                headers={
                    "Content-Disposition": f'attachment; filename="SeisCanvas_{req.state.view_type}_{req.state.section_number}.{fmt}"'
                },
            )
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.post("/api/export/3d")
    def export_scene(req: SceneExportRequest):
        try:
            with guarded_lock():
                output = package_scene(req)
            return Response(
                output,
                media_type=export_queue.MIME[req.format],
                headers={"Content-Disposition": f'attachment; filename="SeisCanvas_3D.{req.format}"'},
            )
        except ValueError as error:
            raise _error(error)

    @router.get("/api/fonts/{family}")
    def export_font(family: str):
        fonts = {"sans": "DejaVu Sans", "serif": "DejaVu Serif"}
        if family not in fonts:
            raise HTTPException(404, "Font not found.")
        return FileResponse(font_manager.findfont(fonts[family]), media_type="font/ttf")

    @router.post("/api/export/queue")
    def queue_add(req: QueueAddRequest):
        try:
            with guarded_lock():
                phase = perf_counter()
                snapshot = make_snapshot(req, context.get_project().read())
                identity = request_scope.get()
                if identity:
                    identity.timings["snapshot_ms"] = (perf_counter() - phase) * 1000
                phase = perf_counter()
                class TimedSink:
                    def add(self, **kwargs):
                        writing = perf_counter()
                        if identity:
                            identity.timings["render_ms"] = (writing - phase) * 1000
                        try:
                            return export_queue.session().add(**kwargs)
                        finally:
                            if identity:
                                identity.timings["publish_ms"] = (perf_counter() - writing) * 1000
                sink = TimedSink()
                if req.kind == "2d":
                    return add_2d(request_survey(req), context.get_horizons(), req, restore=snapshot, sink=sink)
                if req.kind == "map":
                    return add_map(request_survey(req), context.get_horizons(), req, restore=snapshot, sink=sink)
                if req.kind == "profile":
                    return add_profile(request_survey(req), context.get_horizons(), req, restore=snapshot, sink=sink)
                return add_3d(request_survey(req), req, restore=snapshot, sink=sink)
        except KeyError:
            raise HTTPException(404, "Export item not found.")
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.get("/api/export/queue")
    def queue_list():
        try:
            with guarded_lock():
                return export_queue.session().snapshot()
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.get("/api/export/queue/{item_id}/settings")
    def queue_settings(item_id: str):
        try:
            with guarded_lock():
                item = export_queue.session().restore_item(item_id)
                return restore_payload(item, context.get_project().read(), context.get_horizons())
        except KeyError:
            raise HTTPException(404, "找不到该图件的恢复设置。")
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.patch("/api/export/queue/{item_id}")
    def queue_rename(item_id: str, req: RenameRequest):
        try:
            with guarded_lock():
                return export_queue.session().rename(item_id, req.filename)
        except KeyError:
            raise HTTPException(404, "Export item not found.")
        except (ValueError, OSError) as error:
            raise _error(error)

    @router.get("/api/export/queue/{item_id}/file")
    def queue_file(item_id: str, request: Request):
        try:
            requested = request.query_params.get("project_id") or request.headers.get("X-SeisCanvas-Project")
            with context.project_lock:
                project = context.get_project()
                active = project.read()
                if requested and requested != "none":
                    document = project.get(requested)
                    folder = project.export_folder(document)
                    if active and active["id"] == requested:
                        export_queue.bind(folder)
                        queue = export_queue.session()
                    else:
                        queue = export_queue.ExportSession.load(folder)
                elif active:
                    raise HTTPException(428, "图件请求缺少项目 ID。")
                else:
                    queue = export_queue.session()
                path, media_type = queue.file(item_id)
        except (KeyError, ValueError, OSError):
            raise HTTPException(404, "Export file not found.")
        # Inline preview uses the exact same frozen bytes as the ZIP.
        return FileResponse(path, media_type=media_type)

    @router.delete("/api/export/queue/{item_id}")
    def queue_delete(item_id: str):
        try:
            with guarded_lock():
                export_queue.session().delete(item_id)
        except KeyError:
            raise HTTPException(404, "Export item not found.")
        except (ValueError, OSError) as error:
            raise _error(error)
        return {"ok": True}

    @router.delete("/api/export/queue")
    def queue_clear():
        try:
            with guarded_lock():
                export_queue.session().clear()
        except (ValueError, OSError) as error:
            raise _error(error)
        return {"ok": True}

    @router.post("/api/export/archive")
    def export_archive(request: QueueArchiveRequest | None = None):
        try:
            with guarded_lock():
                path, filename, manifest = export_queue.session().archive(request.item_ids if request else None)
        except KeyError:
            raise HTTPException(404, "An export item no longer exists. Refresh the queue and select again.")
        except (ValueError, OSError) as error:
            raise _error(error)
        return ArchiveResponse(
            path,
            media_type="application/zip",
            filename=filename,
            headers={
                "X-Export-Filename": quote(filename),
                "X-Export-Figures": str(manifest["figure_count"]),
            },
        )

    return router
