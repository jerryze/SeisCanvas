"""Request identity is checked again under the same lock as data access."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import time
import re
from fastapi import HTTPException, Request
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool
from backend import export_queue


@dataclass
class RequestScope:
    project_id: str
    epoch: str
    revision: int | None
    result_revision: int | None = None


scope = ContextVar("project_scope", default=None)
store = None
lock = None


def configure(project_store, project_lock):
    global store, lock
    store, lock = project_store, project_lock


def conflict(code, message):
    return HTTPException(409, {"code": code, "message": message})


@contextmanager
def guarded_lock():
    with lock:
        current = store()
        identity = scope.get()
        if identity is not None:
            document = current.read()
            project_id = document["id"] if document else "none"
            if identity.project_id != project_id or (document and identity.epoch != current.epoch):
                raise conflict("PROJECT_CHANGED", "活动项目已在其他页面切换，请重新加载。")
            if identity.revision is not None:
                if document is None or identity.revision != document["revision"]:
                    raise conflict("REVISION_CONFLICT", "项目已在另一个页面更新，请重新加载。")
        export_queue.bind(current.export_folder())
        try:
            yield
        finally:
            document = current.read()
            if identity is not None and document and identity.project_id == document["id"] and identity.epoch == current.epoch:
                identity.result_revision = document["revision"]
                identity.revision = document["revision"]


class ProjectRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()
        async def handle(request: Request):
            # Bootstrap and catalogue are safe without an active identity.
            public = request.method == "GET" and request.url.path in {"/api/workspace", "/api/projects", "/api/catalog"}
            if public or request.url.path.startswith("/api/fonts/"):
                return await handler(request)
            # File embeds cannot attach custom headers. Scope downloads by explicit
            # immutable project ID, never by whichever project is active later.
            if request.method == "GET" and request.url.path.endswith("/file"):
                request.state.download_project = request.query_params.get("project_id")
                return await handler(request)
            project_id = request.headers.get("X-SeisCanvas-Project")
            if project_id is None:
                raise HTTPException(428, {"code": "PROJECT_REQUIRED", "message": "请求缺少项目身份，请重新加载页面。"})
            revision = request.headers.get("X-SeisCanvas-Revision")
            try:
                revision = int(revision) if revision is not None else None
            except ValueError:
                raise HTTPException(400, "Invalid revision")
            identity = RequestScope(project_id, request.headers.get("X-SeisCanvas-Epoch", ""), revision)
            token = scope.set(identity)
            try:
                def check():
                    # Retrying a completed commit with its original identity
                    # returns the result without activating the project again.
                    match = re.fullmatch(r"/api/project-switches/([a-f0-9]{32})/commit", request.url.path)
                    if match:
                        with lock:
                            current = store()
                            pending = current.pending.get(match[1])
                            if pending and pending.get("committed") and pending["expires"] > time.monotonic() and pending["origin"][:2] == (identity.project_id if identity.project_id != "none" else None, identity.epoch) and current.epoch == pending.get("committed_epoch"):
                                identity.project_id = current.read()["id"]
                                identity.epoch = current.epoch
                                identity.revision = current.read()["revision"]
                    with guarded_lock():
                        current = store()
                        for key, value in list(current.pending.items()):
                            if value["expires"] < time.monotonic():
                                current.pending.pop(key, None)
                        # Reads expressed as POST don't change project config.
                        read_post = re.fullmatch(r"/api/(section|sample|scene|horizon-map(?:/profile|/export)?|export(?:/3d)?)", request.url.path)
                        if request.method not in {"GET", "HEAD"} and not read_post and current.read() and identity.revision is None:
                            raise HTTPException(428, {"code": "REVISION_REQUIRED", "message": "请求缺少项目版本，请重新加载页面。"})
                await run_in_threadpool(check)
                response = await handler(request)
                if identity.result_revision is not None:
                    response.headers["X-Project-Revision"] = str(identity.result_revision)
                return response
            finally:
                scope.reset(token)
        return handle
