from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal
from urllib.parse import quote
import numpy as np
from pydantic import BaseModel, Field
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
from backend.export3d import SceneExportRequest, package_scene
from backend.core import (
    Survey,
    Horizon,
    amplitude,
    render,
    CMAPS,
    get_cmap,
    horizon_preview,
    window_indices,
)
from backend.models import ViewState, ExportRequest, Horizon3DStyle, ViewState3D
from backend.scene import slice_data, horizon_mesh, horizon_intersection, scene_data, indices
from backend import resample
from backend.preview import preview_ids, read_samples

from backend.horizon_map import HorizonMapState, HorizonMapExport, map_data, render_map
from backend import export_queue
from backend.export_service import (
    QueueAddRequest,
    RenameRequest,
    add_2d,
    add_3d,
    add_map,
)

ROOT = Path(__file__).resolve().parents[1]
HORIZON_SUFFIXES = {".txt", ".dat"}


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Drop the temporary export session on any graceful shutdown."""
    yield
    export_queue.shutdown()


app = FastAPI(title="SeisCanvas", lifespan=lifespan)
# Local single-user application. Serialize mutations and section/export reads.
lock = RLock()
workspace = tempfile.TemporaryDirectory(prefix="seiscanvas-")
survey = None
horizons = {}
COLORS = ["#f5b942", "#42ddbc", "#ff6b86", "#69acff", "#d593ff", "#ff9559"]


def require_survey():
    if survey is None:
        raise HTTPException(400, "Load a SEG-Y file first.")
    return survey


def add_horizon(h):
    key = uuid4().hex
    horizons[key] = h
    return Horizon3DStyle(
        id=key, name=h.name, color=COLORS[(len(horizons) - 1) % len(COLORS)],
        twt_range=(float(h.data[:, 2].min()), float(h.data[:, 2].max()))
    ).model_dump()


def error(e):
    return HTTPException(400, str(e))


@app.post("/api/horizon-map")
def horizon_map(state: HorizonMapState):
    with lock:
        if state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            return map_data(horizons[state.horizon], state)
        except ValueError as e:
            raise error(e)


@app.post("/api/horizon-map/export")
def horizon_map_export(req: HorizonMapExport):
    with lock:
        if req.state.horizon not in horizons:
            raise HTTPException(404, "Horizon not found.")
        try:
            content = render_map(horizons[req.state.horizon], req.state, req.settings)
            return Response(content, media_type={"png": "image/png", "pdf": "application/pdf", "svg": "image/svg+xml"}[req.settings.format])
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
            survey = new
            horizons.clear()
            styles = [add_horizon(h) for h in hs]
            return {"metadata": new.metadata(), "horizons": styles}
    except (ValueError, OSError, RuntimeError, IndexError) as e:
        raise error(e)


class LocalSegyRequest(BaseModel):
    geometry_mode: Literal["auto", "regular"] = "auto"
    path: str = Field(min_length=1)
    ilbyte: int = Field(189, ge=1, le=237)
    xlbyte: int = Field(21, ge=1, le=237)


import_progress = {}
progress_lock = RLock()


@app.get("/api/segy/progress/{job_id}")
def segy_progress(job_id: str):
    with progress_lock:
        return import_progress.get(job_id, {"percent": 0, "stage": "等待文件选择", "status": "waiting"})


class PickSegyRequest(BaseModel):
    geometry_mode: Literal["auto", "regular"] = "auto"
    job_id: str | None = Field(None, pattern=r"^[a-zA-Z0-9-]{1,64}$")
    ilbyte: int = Field(189, ge=1, le=237)
    xlbyte: int = Field(21, ge=1, le=237)


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
            survey = new
            horizons.clear()
            if old and old.path != path and Path(workspace.name) in old.path.parents:
                shutil.rmtree(old.path.parent, ignore_errors=True)
            return {"metadata": new.metadata(), "horizons": []}
    except (ValueError, OSError, RuntimeError, IndexError, MemoryError) as e:
        raise error(str(e) or "内存不足，请关闭其他大型数据后重试。")


@app.post("/api/segy")
def upload_segy(
    file: UploadFile = File(...), ilbyte: int = Form(189), xlbyte: int = Form(21)
):
    global survey
    if Path(file.filename or "").suffix.lower() not in [".sgy", ".segy"]:
        raise HTTPException(400, "Choose a .sgy or .segy file.")
    folder = Path(workspace.name) / uuid4().hex
    folder.mkdir()
    path = folder / Path(file.filename).name
    try:
        if file.size and shutil.disk_usage(folder).free < file.size + 256 * 1024 * 1024:
            raise ValueError("临时磁盘空间不足。大文件请使用本地路径直接打开，避免上传和复制。")
        with path.open("wb") as out:
            shutil.copyfileobj(file.file, out, length=8 * 1024 * 1024)
        new = Survey(path, ilbyte, xlbyte)
        with lock:
            old = survey
            survey = new
            horizons.clear()
            if old and Path(workspace.name) in old.path.parents:
                shutil.rmtree(old.path.parent)
            return {"metadata": new.metadata(), "horizons": []}
    except (ValueError, OSError, RuntimeError, IndexError) as e:
        shutil.rmtree(folder, ignore_errors=True)
        raise error(e)
    finally:
        file.file.close()


# Only paths selected in the native dialog can be imported through this route.
horizon_selections = {}


class LocalHorizonRequest(BaseModel):
    token: str
    inline_column: int = Field(default=0, ge=0)
    xline_column: int = Field(default=1, ge=0)
    time_column: int = Field(default=2, ge=0)


@app.post("/api/horizons/pick")
def pick_horizon():
    try:
        path = choose_segy("Horizon")
        if not path:
            return {"cancelled": True}
        path = Path(path)
        if path.suffix.lower() not in HORIZON_SUFFIXES:
            raise ValueError("Horizon files must use .txt or .dat extension.")
        preview = horizon_preview(path)
        token = uuid4().hex
        with lock:
            if len(horizon_selections) >= 32:
                horizon_selections.pop(next(iter(horizon_selections)))
            horizon_selections[token] = path
        return {**preview, "token": token, "filename": path.name}
    except (ValueError, OSError) as e:
        raise error(e)


@app.post("/api/horizons/local")
def local_horizon(req: LocalHorizonRequest):
    try:
        with lock:
            path = horizon_selections.get(req.token)
        if path is None:
            raise ValueError("请重新选择层位文件。")
        h = Horizon(path, columns=(req.inline_column, req.xline_column, req.time_column))
        with lock:
            result = [add_horizon(h)]
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
    try:
        columns = (inline_column, xline_column, time_column)
        for file in files:
            if Path(file.filename or "").suffix.lower() not in HORIZON_SUFFIXES:
                raise ValueError("Horizon files must use .txt or .dat extension.")
            with tempfile.NamedTemporaryFile(dir=workspace.name, suffix=".txt") as tmp:
                shutil.copyfileobj(file.file, tmp)
                tmp.flush()
                pending.append(
                    Horizon(tmp.name, Path(file.filename).stem, columns=columns)
                )
        with lock:
            require_survey()
            return [add_horizon(h) for h in pending]
    except (ValueError, OSError, UnicodeError) as e:
        raise error(e)
    finally:
        for file in files:
            file.file.close()


@app.delete("/api/horizons/{key}")
def delete_horizon(key: str):
    with lock:
        horizons.pop(key, None)
    return {"ok": True}


class SectionRequest(ViewState):
    """A viewer request: the visible range comes from ``x_range``/``time_range``."""

    quality: Literal["preview", "interactive", "publication"] = "interactive"
    interpolation: Literal["nearest", "bilinear", "bicubic"] | None = None
    target_width: int | None = Field(None, ge=8, le=8000)
    target_height: int | None = Field(None, ge=8, le=8000)


class SampleRequest(BaseModel):
    """Probe the original SEG-Y for the sample under the cursor."""

    kind: Literal["inline", "crossline", "time"]
    position: float
    inline: float | None = None
    crossline: float | None = None
    time: float | None = None


def nearest_index(coordinates, value):
    return int(np.argmin(np.abs(np.asarray(coordinates, dtype=float) - float(value))))


@app.post("/api/section")
def section(req: SectionRequest):
    try:
        with lock:
            s = require_survey()
            x, t, z = s.section(req.view_type, req.section_number)
            # Amplitude clipping, hover and picking always use the original
            # section; only the raster below is a rendering artefact.
            _, lo, hi = amplitude(z, req.seismic)
            x0, x1 = window_indices(x, req.x_range)
            t0, t1 = window_indices(t, req.time_range)
            window = np.ascontiguousarray(z[t0 : t1 + 1, x0 : x1 + 1])
            native_height, native_width = window.shape
            budget = resample.QUALITY_BUDGETS[req.quality]
            method = resample.method(
                req.interpolation
                if req.interpolation is not None
                else req.seismic.interpolation,
                resample.QUALITY_INTERPOLATION[req.quality],
            )
            adaptive = req.seismic.adaptive_resolution or req.quality != "interactive"
            if adaptive:
                width, height = resample.fit_target(
                    native_width,
                    native_height,
                    req.target_width,
                    req.target_height,
                    budget=budget,
                )
            else:
                width, height = resample.fit_target(
                    native_width, native_height, budget=budget, max_upscale=1.0
                )
            key = (
                "render", req.view_type, req.section_number, x0, x1, t0, t1,
                width, height, method, req.seismic.reverse_polarity,
            )
            raster = s.render_cache.get(key)
            if raster is None:
                raster = resample.resample(window, width, height, method)
                s.render_cache[key] = raster
            else:
                s.render_cache.move_to_end(key)
            return {
                "x": np.linspace(float(x[x0]), float(x[x1]), width).tolist(),
                "time": np.linspace(float(t[t0]), float(t[t1]), height).tolist(),
                # Display pixels only; hover, picking and clipping read the
                # original amplitudes (see /api/sample).
                "z": resample.display_values(
                    raster,
                    min(lo, hi),
                    max(lo, hi),
                    method,
                    resampled=(width, height) != (native_width, native_height),
                ),
                "vmin": lo,
                "vmax": hi,
                "native_shape": [len(t), len(x)],
                "render_shape": [native_height, native_width],
                "preview_shape": [height, width],
                "interpolation": method,
                "adaptive": adaptive,
                "quality": req.quality,
                "window": {
                    "x_range": [float(x[x0]), float(x[x1])],
                    "time_range": [float(t[t0]), float(t[t1])],
                },
                "horizons": {
                    key: h.section(req.view_type, req.section_number)
                    for key, h in horizons.items()
                },
            }
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
        mime = {"png": "image/png", "pdf": "application/pdf", "svg": "image/svg+xml"}[
            fmt
        ]
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
            media_type={
                "png": "image/png",
                "pdf": "application/pdf",
                "svg": "image/svg+xml",
            }[req.format],
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
            return add_3d(require_survey(), req)
    except KeyError:
        raise HTTPException(404, "Export item not found.")
    except (ValueError, OSError) as e:
        raise error(e)


@app.get("/api/export/queue")
def queue_list():
    return export_queue.session().snapshot()


@app.patch("/api/export/queue/{item_id}")
def queue_rename(item_id: str, req: RenameRequest):
    try:
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
        export_queue.session().delete(item_id)
    except KeyError:
        raise HTTPException(404, "Export item not found.")
    return {"ok": True}


@app.delete("/api/export/queue")
def queue_clear():
    export_queue.session().clear()
    return {"ok": True}


@app.post("/api/export/archive")
def export_archive():
    try:
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
