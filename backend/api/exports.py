"""Figure downloads and persistent export queues, independent of app globals."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response
from matplotlib import font_manager
from starlette.types import Receive, Scope, Send

from backend import export_queue
from backend.export3d import package_scene
from backend.export_service import add_2d, add_3d, add_map, add_profile
from backend.horizon import Horizon
from backend.horizon_map import render_map
from backend.models import (
    ExportRequest, HorizonMapExport, QueueAddRequest, QueueArchiveRequest,
    RenameRequest, SceneExportRequest,
)
from backend.project_scope import ProjectRoute, guarded_lock
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


class ArchiveResponse(FileResponse):
    """Each download owns its ZIP, including when sending is interrupted."""
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            Path(self.path).unlink(missing_ok=True)


def _error(error):
    return HTTPException(400, str(error))


def create_export_router(context: ExportContext) -> APIRouter:
    router = APIRouter(route_class=ProjectRoute)

    @router.post("/api/horizon-map/export")
    def horizon_map_export(req: HorizonMapExport):
        with guarded_lock():
            horizons = context.get_horizons()
            if req.state.horizon not in horizons:
                raise HTTPException(404, "Horizon not found.")
            try:
                content = render_map(context.require_survey(), horizons[req.state.horizon],
                                     req.state, req.settings, horizons, req.profile)
                return Response(content, media_type=export_queue.MIME[req.settings.format])
            except ValueError as error:
                raise _error(error)

    @router.post("/api/export")
    def export(req: ExportRequest):
        try:
            with guarded_lock():
                data = render(context.require_survey(), context.get_horizons(), req.state, req.settings)
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
                if req.kind == "2d":
                    return add_2d(context.require_survey(), context.get_horizons(), req)
                if req.kind == "map":
                    return add_map(context.require_survey(), context.get_horizons(), req)
                if req.kind == "profile":
                    return add_profile(context.require_survey(), context.get_horizons(), req)
                return add_3d(context.require_survey(), req)
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
