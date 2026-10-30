from pathlib import Path
from contextlib import asynccontextmanager
import numpy as np
from backend.file_picker import choose_segy, server_path_mode
from uuid import uuid4
import shutil
import tempfile
import time
from copy import deepcopy
from threading import RLock
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from matplotlib.colors import LinearSegmentedColormap, to_hex
from backend.segy import Survey
from backend.horizon import Horizon, horizon_preview
from backend.horizon_geometry import HorizonGeometry
from backend.style import CMAPS, get_cmap
from backend.models import (
    Horizon3DStyle,
    HorizonMapState,
    HorizonProfileRequest,
    LocalHorizonRequest,
    HorizonRenameRequest,
    LocalSegyRequest,
    PickSegyRequest,
    PickHorizonRequest,
    SampleRequest,
    SectionRequest,
    SliceState,
    ViewState3D,
    WorkspaceSave,
    WorkspaceRelink,
    ProjectCreate,
    ProjectRename,
    ProjectSwitch,
    ProjectRelink,
)
from backend.scene import slice_data, horizon_mesh, horizon_intersection, scene_data
from backend.section_service import interactive_section
from backend.preview import preview_ids, read_samples

from backend.horizon_map import PETREL, map_data, map_profile
from backend import export_queue
from backend.workspace import WorkspaceStore, source, check_source, project_name
from backend.project_scope import ProjectRoute, guarded_lock, configure, conflict
from backend.api.exports import ExportContext, create_export_router

ROOT = Path(__file__).resolve().parents[1]
HORIZON_SUFFIXES = {".txt", ".dat"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Release process state while keeping the saved project and figures."""
    try:
        yield
    finally:
        try:
            await run_in_threadpool(export_router.export_jobs.shutdown)
        finally:
            export_queue.shutdown()


app = FastAPI(title="SeisCanvas", version="0.5.0", lifespan=lifespan)
app.router.route_class = ProjectRoute
# Local single-user application. Serialize mutations and section/export reads.
lock = RLock()
workspace = tempfile.TemporaryDirectory(prefix="seiscanvas-")
survey = None
horizons = {}
project = WorkspaceStore()
restored_project = None
configure(lambda: project, lock)
COLORS = ["#f5b942", "#42ddbc", "#ff6b86", "#69acff", "#d593ff", "#ff9559"]


def require_survey():
    if survey is None:
        raise HTTPException(400, "Load a SEG-Y file first.")
    return survey


def require_geometry():
    return survey if survey is not None else HorizonGeometry(horizons)


def horizon_style(key, h, index):
    return Horizon3DStyle(
        id=key, name=h.name, color=COLORS[index % len(COLORS)],
        twt_range=(float(h.data[:, 2].min()), float(h.data[:, 2].max()))
    ).model_dump()


def add_horizons(pending, model_group="", horizon_keys=None):
    global restored_project
    if horizon_keys is not None and len(horizon_keys) != len(pending):
        raise ValueError("层位对应关系数量与导入文件数量不一致。")
    added = {uuid4().hex: h for h in pending}
    styles = [horizon_style(key, h, len(horizons) + index) for index, (key, h) in enumerate(added.items())]
    document = project.read()
    saved = {h["id"]: h for h in (document or {}).get("state", {}).get("view", {}).get("horizons", [])} if document and document.get("state") else {}
    palette = {}
    for entry in (document or {}).get("horizons", []):
        style = saved.get(entry["id"], entry["style"])
        if style.get("horizon_key"):
            palette.setdefault(style["horizon_key"], style["color"])
    for index, style in enumerate(styles):
        key = horizon_keys[index].strip() if horizon_keys is not None else ""
        style.update(model_group=model_group.strip(), horizon_key=key)
        if key:
            palette.setdefault(key, COLORS[len(palette) % len(COLORS)])
            style["color"] = palette[key]
    if document is None:
        document = project.activate(project.create("层位项目", template={
            "source": None, "state": None,
            "horizons": [horizon_entry(s["id"], added[s["id"]], s) for s in styles],
        }))
        restored_project = document["id"]
        export_queue.bind(project.export_folder(document))
    else:
        persist_horizons(added=added, added_styles={s["id"]: s for s in styles})
    horizons.update(added)
    return styles


def add_horizon(h):
    return add_horizons([h])[0]


def horizon_entry(key, h, style):
    return {**source(h.path, columns=list(h.columns)), "id": key, "name": h.name, "style": style}


def persist_horizons(removed=(), added=None, renamed=None, added_styles=None):
    document = project.read()
    if document is None:
        return
    old = {h["id"]: h for h in document["horizons"]}
    entries = [
        {**item, "name": renamed[item["id"]]} if renamed and item["id"] in renamed else item
        for item in document["horizons"] if item["id"] not in removed
    ]
    entries.extend(
        horizon_entry(key, h, (added_styles or {}).get(key) or horizon_style(key, h, len(horizons) + index))
        for index, (key, h) in enumerate((added or {}).items()) if key not in old
    )
    project.update_horizons(entries)


def activate_survey(new, ilbyte, xlbyte, geometry_mode="auto"):
    global survey, restored_project
    current = project.read()
    # The first seismic volume supplements a horizon-only project. Replacing
    # an existing volume still creates a separate project as before.
    retained = dict(horizons) if current and current["source"] is None else {}
    document = project.new(
        source(new.path, ilbyte=ilbyte, xlbyte=xlbyte, geometry_mode=geometry_mode),
        [],
        seismic_view={
            "view_type": "inline", "section_number": int(new.inlines[len(new.inlines) // 2]),
            "x_range": None, "time_range": None,
            "slices": {kind: [SliceState(id=uuid4().hex, position=float(axis[len(axis) // 2])).model_dump()]
                       for kind, axis in (("inline", new.inlines), ("crossline", new.crosslines), ("time", new.times))},
        },
    )
    survey = new
    horizons.clear()
    horizons.update(retained)
    restored_project = document["id"]
    export_queue.bind(project.export_folder(document))
    return workspace_response(document, new, horizons)


def load_document(document):
    loaded_survey, loaded_horizons, issues = None, {}, []
    if document["source"]:
        try:
            item = document["source"]
            loaded_survey = Survey(check_source(item), item["ilbyte"], item["xlbyte"], geometry_mode=item["geometry_mode"])
        except (ValueError, OSError, RuntimeError, IndexError, MemoryError) as e:
            issues.append({"horizon_id": None, "message": str(e)})
    for item in document["horizons"]:
        try:
            loaded_horizons[item["id"]] = Horizon(check_source(item), item["name"], columns=item["columns"])
        except (ValueError, OSError) as e:
            issues.append({"horizon_id": item["id"], "message": str(e)})
    return loaded_survey, loaded_horizons, issues


def workspace_response(document, loaded_survey, loaded_horizons, issues=()):
    saved = (document.get("state") or {}).get("view", {}).get("horizons", [])
    styles = {h["id"]: h for h in saved}
    return {
        "project_id": document["id"], "name": document.get("name", "恢复的项目"),
        "activation_epoch": project.epoch, "revision": document["revision"],
        "updated_at": document["updated_at"], "state": document["state"],
        "metadata": loaded_survey.metadata() if loaded_survey else None,
        "horizon_metadata": HorizonGeometry(loaded_horizons).metadata() if loaded_horizons and loaded_survey is None else None,
        "horizons": [{**styles.get(h["id"], h["style"]), "name": h["name"]} for h in document["horizons"] if h["id"] in loaded_horizons],
        "source": {k: document["source"][k] for k in ("ilbyte", "xlbyte", "geometry_mode")} if document["source"] else None,
        "issues": list(issues),
    }


def restore_workspace(force=False):
    global survey, restored_project
    document = project.read()
    if document is None:
        return {"project_id": None, "activation_epoch": project.epoch, "revision": 0, "metadata": None, "horizons": [], "state": None, "issues": []}
    issues = []
    if not force and restored_project == document["id"]:
        for item in [document["source"], *document["horizons"]]:
            if not item:
                continue
            try:
                check_source(item)
            except (ValueError, OSError):
                force = True
                break
    if force or restored_project != document["id"]:
        survey, loaded_horizons, issues = load_document(document)
        horizons.clear()
        horizons.update(loaded_horizons)
        restored_project = document["id"] if not issues else None
    export_queue.bind(project.export_folder(document))
    return workspace_response(document, survey, horizons, issues)


@app.get("/api/projects")
def project_list(deleted: bool = False):
    try:
        with guarded_lock():
            return project.list(deleted=deleted)
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/projects")
def project_create(req: ProjectCreate):
    try:
        with guarded_lock():
            template = project.get(req.template_id) if req.template_id else None
            document = project.create(req.name, request_id=req.request_id, template=template)
            return {"project_id": document["id"], "revision": document["revision"]}
    except (ValueError, OSError) as e:
        raise error(e)


@app.patch("/api/projects/{project_id}")
def project_rename(project_id: str, req: ProjectRename):
    try:
        with guarded_lock():
            document = project.get(project_id)
            document["name"] = project_name(req.name)
            document["revision"] += 1
            current = project.read()
            document = project.commit(document) if current and current["id"] == project_id else project.write(document)
            return {"name": document["name"], "revision": document["revision"]}
    except (ValueError, OSError) as e:
        raise error(e)


@app.delete("/api/projects/{project_id}")
def project_delete(project_id: str):
    global survey, restored_project
    try:
        with guarded_lock():
            if export_router.export_jobs.has_active(project_id):
                raise conflict("PROJECT_BUSY", "该项目仍有图件在生成或排队，请等待完成或取消排队任务后再删除。")
            was_active = project.delete(project_id)
            if was_active:
                survey, restored_project = None, None
                horizons.clear()
                horizon_selections.clear()
                export_queue.bind(None)
            return {"deleted_id": project_id, "workspace": restore_workspace() if was_active else None}
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/projects/{project_id}/restore")
def project_restore(project_id: str):
    try:
        with guarded_lock():
            return project.restore_deleted(project_id)
    except (ValueError, OSError) as e:
        raise error(e)


@app.delete("/api/projects/{project_id}/permanent")
def project_purge(project_id: str):
    try:
        with guarded_lock():
            if export_router.export_jobs.has_active(project_id):
                raise conflict("PROJECT_BUSY", "该项目仍有图件在生成或排队，暂时无法彻底删除。")
            return project.purge(project_id)
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/projects/{project_id}/close")
def project_close(project_id: str):
    global survey, restored_project
    try:
        with guarded_lock():
            document = project.read()
            if not document or document["id"] != project_id:
                raise conflict("PROJECT_CHANGED", "该项目不是当前打开的项目，请刷新项目列表。")
            project.close()
            survey, restored_project = None, None
            horizons.clear()
            horizon_selections.clear()
            export_queue.bind(None)
            return restore_workspace()
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/project-switches")
def prepare_project(req: ProjectSwitch):
    try:
        with guarded_lock():
            current = project.read()
            if current and req.source_revision != current["revision"]:
                raise conflict("REVISION_CONFLICT", "当前项目仍有未保存更改，请重新保存。")
            document = project.get(req.target_id)
            origin = (current["id"] if current else None, project.epoch, current["revision"] if current else None)
        candidate_survey, candidate_horizons, issues = load_document(document)
        if issues:
            raise HTTPException(422, {"code": "SOURCE_ISSUES", "message": "项目文件需要重新关联，当前项目已保留。", "project_id": document["id"], "issues": issues})
        folder = project.export_folder(document)
        if (folder / "queue.json").exists() or (folder / "queue.json.bak").exists():
            export_queue.ExportSession.load(folder)  # do not activate a broken queue
        with guarded_lock():
            token = uuid4().hex
            project.pending.clear()
            project.pending[token] = {"document": document, "survey": candidate_survey, "horizons": candidate_horizons,
                                      "origin": origin, "expires": time.monotonic() + 300}
            return {"token": token}
    except (ValueError, OSError, RuntimeError, MemoryError) as e:
        raise error(str(e) or "内存不足，当前项目已保留。")


@app.post("/api/project-switches/{token}/commit")
def commit_project(token: str):
    global survey, restored_project
    try:
        with guarded_lock():
            pending = project.pending.get(token)
            if pending is None or pending["expires"] < time.monotonic():
                project.pending.pop(token, None)
                raise conflict("SWITCH_EXPIRED", "切换准备已过期，请重新打开项目。")
            if pending.get("committed"):
                return restore_workspace()
            current = project.read()
            origin = (current["id"] if current else None, project.epoch, current["revision"] if current else None)
            document = pending["document"]
            if pending["origin"] != origin or project.get(document["id"])["revision"] != document["revision"]:
                project.pending.pop(token, None)
                raise conflict("REVISION_CONFLICT", "项目在准备期间发生变化，请重新打开。")
            for item in [document["source"], *document["horizons"]]:
                if item:
                    check_source(item)
            # Persist active identity before publishing the candidate in memory.
            project.activate(document)
            survey = pending.pop("survey")
            horizons.clear()
            horizons.update(pending.pop("horizons"))
            restored_project = document["id"]
            horizon_selections.clear()
            pending["committed"] = True
            pending["committed_epoch"] = project.epoch
            project.pending[token] = pending
            export_queue.bind(project.export_folder(document))
            return workspace_response(document, survey, horizons)
    except (ValueError, OSError) as e:
        raise error(e)


@app.delete("/api/project-switches/{token}")
def cancel_project(token: str):
    with guarded_lock():
        project.pending.pop(token, None)
    return {"ok": True}


@app.post("/api/projects/{project_id}/relink")
def project_relink(project_id: str, req: ProjectRelink):
    try:
        with guarded_lock():
            document = project.get(project_id)
            revision = document["revision"]
            item = document["source"] if req.horizon_id is None else next(h for h in document["horizons"] if h["id"] == req.horizon_id)
            if item is None:
                raise ValueError("空项目尚未导入数据。")
        path = req.path or choose_segy("Horizon" if req.horizon_id else "SEG-Y")
        if not path:
            return {"cancelled": True}
        selected_source = source(path)
        selected_identity = {key: str(selected_source[key]) for key in ("size", "mtime_ns")}
        if req.confirm and req.file_identity != selected_identity:
            raise conflict("SOURCE_CHANGED", "文件在确认前发生变化，请重新选择文件。")
        if req.horizon_id:
            loaded = Horizon(path, item["name"], columns=item["columns"])
            summary = {"filename": Path(path).name, "points": len(loaded.data)}
        else:
            loaded = Survey(path, item["ilbyte"], item["xlbyte"], geometry_mode=item["geometry_mode"])
            summary = loaded.metadata()
        check_source(selected_source)
        if not req.confirm:
            return {"path": str(Path(path).resolve()), "revision": revision, "previous_path": item["path"], "metadata": summary, "file_identity": selected_identity}
        with guarded_lock():
            if req.revision != revision or project.get(project_id)["revision"] != revision:
                raise conflict("REVISION_CONFLICT", "项目已更新，请重新选择文件。")
            item.update(source(path))
            document["revision"] += 1
            # Source replacement can change coordinates; reset dependent viewports.
            state = document.get("state")
            if state and not req.horizon_id:
                state["view"].update(x_range=None, time_range=None)
                state["view"]["section_number"] = summary["inlines"][len(summary["inlines"]) // 2]
                state["view"]["view_type"] = "inline"
                state["view"]["slices"] = {"inline": [], "crossline": [], "time": []}
                state.get("map", {}).get("state", {}).update(x_range=None, y_range=None)
                state.get("map", {}).update(profileA=None, profileB=None, profileOn=False, profileXRange=None, profileTimeRange=None)
            if project.read() and project.read()["id"] == project_id:
                project.commit(document)
                project.epoch = uuid4().hex
                return restore_workspace(force=True)
            project.write(document)
            return {"relinked": True}
    except (ValueError, OSError, RuntimeError, IndexError, StopIteration) as e:
        raise error(str(e) or "找不到需要重新关联的文件。")


@app.get("/api/workspace")
def workspace_current():
    try:
        with guarded_lock():
            return restore_workspace()
    except (ValueError, OSError) as e:
        raise error(e)


@app.put("/api/workspace")
def workspace_save(req: WorkspaceSave):
    with guarded_lock():
        try:
            if restored_project != req.project_id:
                raise ValueError("项目尚未完整恢复，已保留原来的保存记录。")
            document = project.save_state(req.project_id, req.revision, req.state)
            return {"revision": document["revision"], "updated_at": document["updated_at"]}
        except ValueError as e:
            raise HTTPException(409, str(e))
        except OSError as e:
            raise error(e)


@app.post("/api/workspace/relink")
def workspace_relink(req: WorkspaceRelink):
    from copy import deepcopy
    try:
        with guarded_lock():
            document = project.read()
            if document is None or document["id"] != req.project_id:
                raise ValueError("项目已切换，请刷新页面。")
            document = deepcopy(document)
            item = document["source"] if req.horizon_id is None else next(
                h for h in document["horizons"] if h["id"] == req.horizon_id
            )
        path = choose_segy("Horizon" if req.horizon_id else "SEG-Y")
        if not path:
            return {"cancelled": True}
        if req.horizon_id:
            Horizon(path, item["name"], columns=item["columns"])
        else:
            Survey(path, item["ilbyte"], item["xlbyte"], geometry_mode=item["geometry_mode"])
        with guarded_lock():
            if project.read()["id"] != req.project_id:
                raise ValueError("项目已切换，请刷新页面。")
            document = deepcopy(project.read())
            item = document["source"] if req.horizon_id is None else next(
                h for h in document["horizons"] if h["id"] == req.horizon_id
            )
            item.update(source(path))
            document["revision"] += 1
            project.commit(document)
            project.epoch = uuid4().hex
            return restore_workspace(force=True)
    except (ValueError, OSError, RuntimeError, IndexError, StopIteration) as e:
        raise error(str(e) or "找不到需要重新定位的层位。")


def error(e):
    return HTTPException(400, str(e))


@app.post("/api/horizon-map")
def horizon_map(state: HorizonMapState):
    with guarded_lock():
        if state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            return map_data(survey, horizons[state.horizon], state, horizons)
        except ValueError as e:
            raise error(e)


@app.post("/api/horizon-map/profile")
def horizon_map_profile(req: HorizonProfileRequest):
    with guarded_lock():
        if req.state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            return map_profile(
                require_geometry(),
                horizons[req.state.horizon],
                req.state,
                horizons,
                req.a,
                req.b,
                req.target_width,
                req.target_height,
                req.interpolation,
                req.section_state(),
                include_overview=req.include_overview,
            )
        except ValueError as e:
            raise error(e)


@app.get("/api/catalog")
def catalog():
    # Preview palette data only; keep the available seismic palettes unchanged.
    map_palettes = {
        name: LinearSegmentedColormap.from_list("petrel", PETREL, N=256)
        if name == "petrel" else get_cmap(name)
        for name in ("petrel", "turbo", "viridis", "cividis", "jet", "RdBu", "coolwarm", "seismic", "magma")
    }
    return {
        "server_path_mode": server_path_mode(),
        "colormaps": {
            name: [[i / 255, to_hex(get_cmap(name)(i / 255))] for i in range(256)]
            for name in CMAPS
        },
        "map_colormaps": {
            name: [[i / 255, to_hex(cmap(i / 255))] for i in range(256)]
            for name, cmap in map_palettes.items()
        },
    }


import_progress = {}
progress_lock = RLock()


@app.get("/api/segy/progress/{job_id}")
def segy_progress(job_id: str):
    with progress_lock:
        return import_progress.get(job_id, {"percent": 0, "stage": "等待文件选择", "status": "waiting"})


@app.post("/api/segy/pick")
def pick_local_segy(req: PickSegyRequest):
    job_id = req.job_id or uuid4().hex
    def report(percent, stage, status="running"):
        with progress_lock:
            import_progress[job_id] = dict(percent=round(percent), stage=stage, status=status)
            if len(import_progress) > 32:
                for key in list(import_progress):
                    if key != job_id and import_progress[key]["status"] in ["done", "cancelled", "error"]:
                        del import_progress[key]
                        break
    report(0, "正在读取服务器文件" if req.path else "请在系统窗口选择文件", "waiting")
    try:
        path = req.path if req.path is not None else choose_segy()
        if path is None:
            report(0, "已取消导入", "cancelled")
            return {"cancelled": True}
        result = open_local_segy(LocalSegyRequest(path=path, ilbyte=req.ilbyte, xlbyte=req.xlbyte, geometry_mode=req.geometry_mode), report)
        report(100, "导入完成", "done")
        return result
    except Exception as e:
        report(0, "导入失败", "error")
        if isinstance(e, HTTPException):
            raise
        raise error(e)


@app.post("/api/segy/local")
def local_segy_endpoint(req: LocalSegyRequest):
    return open_local_segy(req)


def open_local_segy(req: LocalSegyRequest, progress=None):
    """Open an existing file on the local server, without copying its samples."""
    global survey
    path = Path(req.path.strip()).expanduser()
    if not path.is_absolute():
        raise HTTPException(400, "请填写 SEG-Y 文件的绝对路径。")
    if path.suffix.lower() not in [".sgy", ".segy"] or not path.is_file():
        raise HTTPException(400, "文件不存在，或不是 .sgy / .segy 文件。")
    try:
        new = Survey(path, req.ilbyte, req.xlbyte, progress=progress, geometry_mode=req.geometry_mode)
        with guarded_lock():
            old = survey
            result = activate_survey(new, req.ilbyte, req.xlbyte, req.geometry_mode)
            if old and old.path != path and Path(workspace.name) in old.path.parents:
                shutil.rmtree(old.path.parent, ignore_errors=True)
            return result
    except (ValueError, OSError, RuntimeError, IndexError, MemoryError) as e:
        raise error(str(e) or "内存不足，请关闭其他大型数据后重试。")


@app.post("/api/segy")
def upload_segy(
    file: UploadFile = File(...), ilbyte: int = Form(189), xlbyte: int = Form(21)
):
    global survey
    if Path(file.filename or "").suffix.lower() not in [".sgy", ".segy"]:
        raise HTTPException(400, "Choose a .sgy or .segy file.")
    folder = project.asset_folder()
    path = folder / Path(file.filename).name
    try:
        if file.size and shutil.disk_usage(folder).free < file.size + 256 * 1024 * 1024:
            raise ValueError("临时磁盘空间不足。大文件请使用本地路径直接打开，避免上传和复制。")
        with path.open("wb") as out:
            shutil.copyfileobj(file.file, out, length=8 * 1024 * 1024)
        new = Survey(path, ilbyte, xlbyte)
        with guarded_lock():
            old = survey
            result = activate_survey(new, ilbyte, xlbyte)
            if old and Path(workspace.name) in old.path.parents:
                shutil.rmtree(old.path.parent)
            return result
    except Exception as e:
        shutil.rmtree(folder, ignore_errors=True)
        if isinstance(e, HTTPException):
            raise
        raise error(e)
    finally:
        file.file.close()


# Preview tokens bind selected server files to the current project activation.
horizon_selections = {}


@app.post("/api/horizons/pick")
def pick_horizon(req: PickHorizonRequest | None = None):
    try:
        paths = req.paths if req is not None else choose_segy("Horizon", multiple=True)
        if not paths:
            return {"cancelled": True}
        paths = [Path(str(path).strip() if req is not None else path).expanduser() for path in paths]
        for path in paths:
            if not path.is_absolute() or not path.is_file():
                raise ValueError(f"请填写存在的服务器文件绝对路径：{path}")
            if path.suffix.lower() not in HORIZON_SUFFIXES:
                raise ValueError(f"{path.name}: Horizon files must use .txt or .dat extension.")
        preview = horizon_preview(paths[0])
        token = uuid4().hex
        with guarded_lock():
            if len(horizon_selections) >= 32:
                horizon_selections.pop(next(iter(horizon_selections)))
            horizon_selections[token] = (project.read()["id"] if project.read() else None, project.epoch, paths)
        return {**preview, "token": token, "filename": paths[0].name, "filenames": [path.name for path in paths]}
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/horizons/local")
def local_horizon(req: LocalHorizonRequest):
    try:
        with guarded_lock():
            selection = horizon_selections.get(req.token)
            paths = selection[2] if selection and selection[:2] == (project.read()["id"] if project.read() else None, project.epoch) else None
        if paths is None:
            raise ValueError("请重新选择层位文件。")
        pending = [Horizon(path, columns=(req.inline_column, req.xline_column, req.time_column)) for path in paths]
        with guarded_lock():
            result = add_horizons(pending, req.model_group, req.horizon_keys)
            horizon_selections.pop(req.token, None)
        return result
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/horizons/preview")
def preview_horizon(file: UploadFile = File(...)):
    try:
        if Path(file.filename or "").suffix.lower() not in HORIZON_SUFFIXES:
            raise ValueError("Horizon files must use .txt or .dat extension.")
        with tempfile.NamedTemporaryFile(dir=workspace.name, suffix=".txt") as tmp:
            shutil.copyfileobj(file.file, tmp)
            tmp.flush()
            result = horizon_preview(tmp.name)
        result["filename"] = Path(file.filename).name
        return result
    except (ValueError, OSError, UnicodeError) as e:
        raise error(e)
    finally:
        file.file.close()


@app.post("/api/horizons")
def upload_horizons(
    files: list[UploadFile] = File(...),
    inline_column: int = Form(0),
    xline_column: int = Form(1),
    time_column: int = Form(2),
):
    pending = []
    folders = []
    try:
        columns = (inline_column, xline_column, time_column)
        for file in files:
            if Path(file.filename or "").suffix.lower() not in HORIZON_SUFFIXES:
                raise ValueError("Horizon files must use .txt or .dat extension.")
            folder = project.asset_folder()
            folders.append(folder)
            path = folder / Path(file.filename).name
            with path.open("wb") as output:
                shutil.copyfileobj(file.file, output)
            pending.append(Horizon(path, Path(file.filename).stem, columns=columns))
        with guarded_lock():
            result = add_horizons(pending)
            return result
    except Exception as e:
        for folder in folders:
            shutil.rmtree(folder, ignore_errors=True)
        if isinstance(e, HTTPException):
            raise
        raise error(e)
    finally:
        for file in files:
            file.file.close()


@app.patch("/api/horizons/{key}")
def rename_horizon(key: str, req: HorizonRenameRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "层位名不能为空。")
    with guarded_lock():
        if key not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            persist_horizons(renamed={key: name})
        except OSError as e:
            raise error(e)
        horizons[key].name = name
    return {"id": key, "name": name}


@app.delete("/api/horizons/{key}")
def delete_horizon(key: str):
    with guarded_lock():
        try:
            persist_horizons(removed=(key,))
        except OSError as e:
            raise error(e)
        horizons.pop(key, None)
    return {"ok": True}


def nearest_index(coordinates, value):
    return int(np.argmin(np.abs(np.asarray(coordinates, dtype=float) - float(value))))


@app.post("/api/section")
def section(req: SectionRequest):
    try:
        with guarded_lock():
            return interactive_section(require_geometry(), horizons, req)
    except ValueError as e:
        raise error(e)


@app.post("/api/sample")
def sample(req: SampleRequest):
    """Return the original amplitude nearest to a cursor position."""
    try:
        with guarded_lock():
            s = require_survey()
            if req.kind == "time":
                if req.inline is None or req.crossline is None:
                    raise ValueError("A time slice needs inline and crossline.")
                row = nearest_index(s.times, req.position)
                snapped_time = float(s.times[row])
                snapped_inline = float(s.inlines[nearest_index(s.inlines, req.inline)])
                snapped_crossline = float(
                    s.crosslines[nearest_index(s.crosslines, req.crossline)]
                )
                trace = preview_ids(s, [snapped_inline], [snapped_crossline])
                value = read_samples(s, trace, [row]).reshape(-1)[0]
                position = snapped_time
            else:
                axis = s.inlines if req.kind == "inline" else s.crosslines
                position = float(axis[nearest_index(axis, req.position)])
                horizontal = req.crossline if req.kind == "inline" else req.inline
                if horizontal is None or req.time is None:
                    raise ValueError("A section needs a trace and a time value.")
                x, trace_ids = s.section_indices(req.kind, int(position))
                t = s.times
                column = nearest_index(x, horizontal)
                row = nearest_index(t, req.time)
                # Probe one original sample without materializing a full section.
                # Vertical sections historically replace NaN/Inf in float32.
                value = np.nan_to_num(read_samples(s, trace_ids[column:column + 1], [row]), copy=False)[0, 0]
                snapped_time = float(t[row])
                snapped_inline = float(position) if req.kind == "inline" else float(x[column])
                snapped_crossline = float(x[column]) if req.kind == "inline" else float(position)
            return {
                "kind": req.kind,
                "position": position,
                "inline": snapped_inline,
                "crossline": snapped_crossline,
                "time": snapped_time,
                "amplitude": float(value) if np.isfinite(value) else None,
                "source": "original",
            }
    except ValueError as e:
        raise error(e)


@app.post("/api/scene")
def scene(state: ViewState3D):
    try:
        with guarded_lock():
            return scene_data(require_geometry(), horizons, state)
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/seismic/{kind}/{position}")
def seismic_slice(kind: str, position: float, maximum: int = Query(256, ge=2, le=512)):
    if kind not in ["inline", "crossline", "timeslice"]:
        raise HTTPException(404, "Unknown slice type.")
    try:
        with guarded_lock():
            data, _ = slice_data(
                require_survey(),
                "time" if kind == "timeslice" else kind,
                position,
                maximum,
            )
            return data
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/horizons/{key}/surface")
def full_surface(key: str, maximum: int = Query(256, ge=2, le=512)):
    try:
        with guarded_lock():
            if key not in horizons:
                raise HTTPException(404, "Horizon not found.")
            return horizon_mesh(horizons[key], maximum)
    except ValueError as e:
        raise error(e)


@app.get("/api/horizons/{key}/intersection/{kind}/{position}")
def intersection(
    key: str, kind: str, position: float, tolerance: float = Query(4, ge=0, le=1000)
):
    if kind not in ["inline", "crossline", "time"]:
        raise HTTPException(404, "Unknown intersection type.")
    try:
        with guarded_lock():
            if key not in horizons:
                raise HTTPException(404, "Horizon not found.")
            return horizon_intersection(horizons[key], kind, position, tolerance)
    except ValueError as e:
        raise error(e)


export_router = create_export_router(ExportContext(
    require_survey=require_survey, get_survey=lambda: survey, get_horizons=lambda: horizons,
    get_project=lambda: project, project_lock=lock,
))
app.include_router(export_router)


DIST = ROOT / "frontend/dist"
if DIST.exists():
    # Mount after the API routes so the built app also serves root-level public
    # files (favicons), while /api continues to resolve to the handlers above.
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
