from pathlib import Path
from contextlib import asynccontextmanager
from urllib.parse import quote
import numpy as np
from backend.file_picker import choose_segy
from uuid import uuid4
import shutil
import tempfile
from threading import RLock
from fastapi import FastAPI, File, UploadFile, Form, HTTPException, Query
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
from matplotlib.colors import to_hex
from matplotlib import font_manager
from backend.export3d import package_scene
from backend.segy import Survey
from backend.horizon import Horizon, horizon_preview
from backend.rendering import render
from backend.style import CMAPS, get_cmap
from backend.models import (
    ExportRequest,
    Horizon3DStyle,
    HorizonMapExport,
    HorizonMapState,
    HorizonProfileRequest,
    LocalHorizonRequest,
    HorizonRenameRequest,
    LocalSegyRequest,
    PickSegyRequest,
    QueueAddRequest,
    RenameRequest,
    SampleRequest,
    SceneExportRequest,
    SectionRequest,
    ViewState3D,
    WorkspaceSave,
    WorkspaceRelink,
)
from backend.scene import slice_data, horizon_mesh, horizon_intersection, scene_data
from backend.section_service import interactive_section
from backend.preview import preview_ids, read_samples

from backend.horizon_map import map_data, map_profile, render_map
from backend import export_queue
from backend.workspace import WorkspaceStore, source, check_source
from backend.export_service import (
    add_2d,
    add_3d,
    add_map,
    add_profile,
)

ROOT = Path(__file__).resolve().parents[1]
HORIZON_SUFFIXES = {".txt", ".dat"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Release process state while keeping the saved project and figures."""
    yield
    export_queue.shutdown()


app = FastAPI(title="SeisCanvas", lifespan=lifespan)
# Local single-user application. Serialize mutations and section/export reads.
lock = RLock()
workspace = tempfile.TemporaryDirectory(prefix="seiscanvas-")
survey = None
horizons = {}
project = WorkspaceStore()
restored_project = None
COLORS = ["#f5b942", "#42ddbc", "#ff6b86", "#69acff", "#d593ff", "#ff9559"]


def require_survey():
    if survey is None:
        raise HTTPException(400, "Load a SEG-Y file first.")
    return survey


def horizon_style(key, h, index):
    return Horizon3DStyle(
        id=key, name=h.name, color=COLORS[index % len(COLORS)],
        twt_range=(float(h.data[:, 2].min()), float(h.data[:, 2].max()))
    ).model_dump()


def add_horizons(pending):
    added = {uuid4().hex: h for h in pending}
    styles = [horizon_style(key, h, len(horizons) + index) for index, (key, h) in enumerate(added.items())]
    persist_horizons(added=added)
    horizons.update(added)
    return styles


def add_horizon(h):
    return add_horizons([h])[0]


def horizon_entry(key, h, style):
    return {**source(h.path, columns=list(h.columns)), "id": key, "name": h.name, "style": style}


def persist_horizons(removed=(), added=None, renamed=None):
    document = project.read()
    if document is None:
        return
    old = {h["id"]: h for h in document["horizons"]}
    entries = [
        {**item, "name": renamed[item["id"]]} if renamed and item["id"] in renamed else item
        for item in document["horizons"] if item["id"] not in removed
    ]
    entries.extend(
        horizon_entry(key, h, horizon_style(key, h, len(horizons) + index))
        for index, (key, h) in enumerate((added or {}).items()) if key not in old
    )
    project.update_horizons(entries)


def activate_survey(new, ilbyte, xlbyte, geometry_mode="auto", imported=()):
    global survey, restored_project
    pending = {uuid4().hex: h for h in imported}
    styles = [horizon_style(key, h, i) for i, (key, h) in enumerate(pending.items())]
    document = project.new(
        source(new.path, ilbyte=ilbyte, xlbyte=xlbyte, geometry_mode=geometry_mode),
        [horizon_entry(style["id"], pending[style["id"]], style) for style in styles],
    )
    survey = new
    horizons.clear()
    horizons.update(pending)
    restored_project = document["id"]
    return {"metadata": new.metadata(), "horizons": styles, "project_id": document["id"], "revision": document["revision"]}


def restore_workspace(force=False):
    global survey, restored_project
    document = project.read()
    if document is None:
        return {"project_id": None, "metadata": None, "horizons": [], "state": None, "issues": []}
    issues = []
    if not force and restored_project == document["id"]:
        for item in [document["source"], *document["horizons"]]:
            try:
                check_source(item)
            except (ValueError, OSError):
                force = True
                break
    if force or restored_project != document["id"]:
        loaded_survey = None
        loaded_horizons = {}
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
        survey = loaded_survey
        horizons.clear()
        horizons.update(loaded_horizons)
        # Retry failed restores on the next request; never rewrite the project.
        restored_project = document["id"] if not issues else None
    saved = (document.get("state") or {}).get("view", {}).get("horizons", [])
    styles = {h["id"]: h for h in saved}
    return {
        "project_id": document["id"], "revision": document["revision"],
        "updated_at": document["updated_at"], "state": document["state"],
        "metadata": survey.metadata() if survey else None,
        "horizons": [{**styles.get(h["id"], h["style"]), "name": h["name"]} for h in document["horizons"] if h["id"] in horizons],
        "source": {k: document["source"][k] for k in ("ilbyte", "xlbyte", "geometry_mode")},
        "issues": issues,
    }


@app.get("/api/workspace")
def workspace_current():
    try:
        with lock:
            return restore_workspace()
    except (ValueError, OSError) as e:
        raise error(e)


@app.put("/api/workspace")
def workspace_save(req: WorkspaceSave):
    with lock:
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
        with lock:
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
        with lock:
            if project.read()["id"] != req.project_id:
                raise ValueError("项目已切换，请刷新页面。")
            document = deepcopy(project.read())
            item = document["source"] if req.horizon_id is None else next(
                h for h in document["horizons"] if h["id"] == req.horizon_id
            )
            item.update(source(path))
            project.commit(document)
            return restore_workspace(force=True)
    except (ValueError, OSError, RuntimeError, IndexError, StopIteration) as e:
        raise error(str(e) or "找不到需要重新定位的层位。")


def error(e):
    return HTTPException(400, str(e))


@app.post("/api/horizon-map")
def horizon_map(state: HorizonMapState):
    with lock:
        if state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            return map_data(require_survey(), horizons[state.horizon], state, horizons)
        except ValueError as e:
            raise error(e)


@app.post("/api/horizon-map/profile")
def horizon_map_profile(req: HorizonProfileRequest):
    with lock:
        if req.state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            return map_profile(
                require_survey(),
                horizons[req.state.horizon],
                req.state,
                horizons,
                req.a,
                req.b,
                req.target_width,
                req.target_height,
                req.interpolation,
            )
        except ValueError as e:
            raise error(e)


@app.post("/api/horizon-map/export")
def horizon_map_export(req: HorizonMapExport):
    with lock:
        if req.state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            content = render_map(require_survey(), horizons[req.state.horizon], req.state, req.settings, horizons)
            return Response(content, media_type=export_queue.MIME[req.settings.format])
        except ValueError as e:
            raise error(e)


@app.get("/api/catalog")
def catalog():
    return {
        "segy": [
            p.name
            for p in sorted((ROOT / "data").glob("*"))
            if p.suffix.lower() in [".sgy", ".segy"]
        ],
        "horizons": [p.name for p in sorted((ROOT / "data/horizons").glob("*.txt"))],
        "colormaps": {
            name: [[i / 255, to_hex(get_cmap(name)(i / 255))] for i in range(256)]
            for name in CMAPS
        },
    }


@app.post("/api/example")
def example(ilbyte: int = 189, xlbyte: int = 21):
    global survey
    try:
        paths = sorted(
            p
            for p in (ROOT / "data").glob("*")
            if p.suffix.lower() in [".sgy", ".segy"]
        )
        if not paths:
            raise ValueError("No example SEG-Y found in data/.")
        new = Survey(paths[0], ilbyte, xlbyte)
        hs = [Horizon(p) for p in sorted((ROOT / "data/horizons").glob("*.txt"))]
        with lock:
            return activate_survey(new, ilbyte, xlbyte, imported=hs)
    except (ValueError, OSError, RuntimeError, IndexError) as e:
        raise error(e)


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
    report(0, "请在系统窗口选择文件", "waiting")
    try:
        path = choose_segy()
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
        with lock:
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
        with lock:
            old = survey
            result = activate_survey(new, ilbyte, xlbyte)
            if old and Path(workspace.name) in old.path.parents:
                shutil.rmtree(old.path.parent)
            return result
    except (ValueError, OSError, RuntimeError, IndexError) as e:
        shutil.rmtree(folder, ignore_errors=True)
        raise error(e)
    finally:
        file.file.close()


# Only paths selected in the native dialog can be imported through this route.
horizon_selections = {}


@app.post("/api/horizons/pick")
def pick_horizon():
    try:
        paths = choose_segy("Horizon", multiple=True)
        if not paths:
            return {"cancelled": True}
        paths = [Path(path) for path in paths]
        for path in paths:
            if path.suffix.lower() not in HORIZON_SUFFIXES:
                raise ValueError(f"{path.name}: Horizon files must use .txt or .dat extension.")
        preview = horizon_preview(paths[0])
        token = uuid4().hex
        with lock:
            if len(horizon_selections) >= 32:
                horizon_selections.pop(next(iter(horizon_selections)))
            horizon_selections[token] = paths
        return {**preview, "token": token, "filename": paths[0].name, "filenames": [path.name for path in paths]}
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/horizons/local")
def local_horizon(req: LocalHorizonRequest):
    try:
        with lock:
            paths = horizon_selections.get(req.token)
        if paths is None:
            raise ValueError("请重新选择层位文件。")
        pending = [Horizon(path, columns=(req.inline_column, req.xline_column, req.time_column)) for path in paths]
        with lock:
            result = add_horizons(pending)
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
        with lock:
            require_survey()
            result = add_horizons(pending)
            return result
    except (ValueError, OSError, UnicodeError) as e:
        for folder in folders:
            shutil.rmtree(folder, ignore_errors=True)
        raise error(e)
    finally:
        for file in files:
            file.file.close()


@app.patch("/api/horizons/{key}")
def rename_horizon(key: str, req: HorizonRenameRequest):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "层位名不能为空。")
    with lock:
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
    with lock:
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
        with lock:
            return interactive_section(require_survey(), horizons, req)
    except ValueError as e:
        raise error(e)


@app.post("/api/sample")
def sample(req: SampleRequest):
    """Return the original amplitude nearest to a cursor position."""
    try:
        with lock:
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
                x, t, z = s.section(req.kind, int(position))
                column = nearest_index(x, horizontal)
                row = nearest_index(t, req.time)
                value = z[row, column]
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


@app.post("/api/export")
def export(req: ExportRequest):
    try:
        with lock:
            data = render(require_survey(), horizons, req.state, req.settings)
        fmt = req.settings.format
        mime = export_queue.MIME[fmt]
        return Response(
            data,
            media_type=mime,
            headers={
                "Content-Disposition": f'attachment; filename="SeisCanvas_{req.state.view_type}_{req.state.section_number}.{fmt}"'
            },
        )
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/export/3d")
def export_scene(req: SceneExportRequest):
    try:
        with lock:
            output = package_scene(req)
        return Response(
            output,
            media_type=export_queue.MIME[req.format],
            headers={
                "Content-Disposition": f'attachment; filename="SeisCanvas_3D.{req.format}"'
            },
        )
    except ValueError as e:
        raise error(e)


@app.get("/api/fonts/{family}")
def export_font(family: str):
    fonts = {"sans": "DejaVu Sans", "serif": "DejaVu Serif"}
    if family not in fonts:
        raise HTTPException(404, "Font not found.")
    return FileResponse(font_manager.findfont(fonts[family]), media_type="font/ttf")


# ---------------------------------------------------------------------------
# Export queue: render once on Add to Export, then only reorganise files.
# ---------------------------------------------------------------------------


@app.post("/api/export/queue")
def queue_add(req: QueueAddRequest):
    try:
        with lock:
            if req.kind == "2d":
                return add_2d(require_survey(), horizons, req)
            if req.kind == "map":
                return add_map(require_survey(), horizons, req)
            if req.kind == "profile":
                return add_profile(require_survey(), horizons, req)
            return add_3d(require_survey(), req)
    except KeyError:
        raise HTTPException(404, "Export item not found.")
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/export/queue")
def queue_list():
    try:
        with lock:
            return export_queue.session().snapshot()
    except (ValueError, OSError) as e:
        raise error(e)


@app.patch("/api/export/queue/{item_id}")
def queue_rename(item_id: str, req: RenameRequest):
    try:
        with lock:
            return export_queue.session().rename(item_id, req.filename)
    except KeyError:
        raise HTTPException(404, "Export item not found.")
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/export/queue/{item_id}/file")
def queue_file(item_id: str):
    try:
        path, media_type = export_queue.session().file(item_id)
    except KeyError:
        raise HTTPException(404, "Export file not found.")
    # Inline so Preview shows exactly the bytes that go into the ZIP.
    return FileResponse(path, media_type=media_type)


@app.delete("/api/export/queue/{item_id}")
def queue_delete(item_id: str):
    try:
        with lock:
            export_queue.session().delete(item_id)
    except KeyError:
        raise HTTPException(404, "Export item not found.")
    except (ValueError, OSError) as e:
        raise error(e)
    return {"ok": True}


@app.delete("/api/export/queue")
def queue_clear():
    try:
        with lock:
            export_queue.session().clear()
    except (ValueError, OSError) as e:
        raise error(e)
    return {"ok": True}


@app.post("/api/export/archive")
def export_archive():
    try:
        with lock:
            path, filename, manifest = export_queue.session().archive()
    except ValueError as e:
        raise error(e)
    return FileResponse(
        path,
        media_type="application/zip",
        filename=filename,
        headers={
            # Percent-encoded so a non-ASCII dataset name is still header-safe.
            "X-Export-Filename": quote(filename),
            "X-Export-Figures": str(manifest["figure_count"]),
        },
    )



@app.post("/api/scene")
def scene(state: ViewState3D):
    try:
        with lock:
            return scene_data(require_survey(), horizons, state)
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/seismic/{kind}/{position}")
def seismic_slice(kind: str, position: float, maximum: int = Query(256, ge=2, le=512)):
    if kind not in ["inline", "crossline", "timeslice"]:
        raise HTTPException(404, "Unknown slice type.")
    try:
        with lock:
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
        with lock:
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
        with lock:
            if key not in horizons:
                raise HTTPException(404, "Horizon not found.")
            return horizon_intersection(horizons[key], kind, position, tolerance)
    except ValueError as e:
        raise error(e)


DIST = ROOT / "frontend/dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")
