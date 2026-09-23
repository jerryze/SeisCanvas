from pathlib import Path
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
)
from backend.models import ViewState, ExportRequest, Horizon3DStyle, ViewState3D
from backend.scene import slice_data, horizon_mesh, horizon_intersection, scene_data

ROOT = Path(__file__).resolve().parents[1]
HORIZON_SUFFIXES = {".txt", ".dat"}
app = FastAPI(title="SeisCanvas")
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
        id=key, name=h.name, color=COLORS[(len(horizons) - 1) % len(COLORS)]
    ).model_dump()


def error(e):
    return HTTPException(400, str(e))


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
        with path.open("wb") as out:
            shutil.copyfileobj(file.file, out)
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


@app.post("/api/section")
def section(state: ViewState):
    try:
        with lock:
            s = require_survey()
            x, t, z = s.section(state.view_type, state.section_number)
            _, lo, hi = amplitude(z, state.seismic)
            return {
                "x": x.tolist(),
                "time": t.tolist(),
                "z": z.tolist(),
                "vmin": lo,
                "vmax": hi,
                "horizons": {
                    key: h.section(state.view_type, state.section_number)
                    for key, h in horizons.items()
                },
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
            media_type={"pdf": "application/pdf", "svg": "image/svg+xml"}[req.format],
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
