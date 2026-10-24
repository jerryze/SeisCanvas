"""Persistent export session: rendered figures, queue metadata and the ZIP builder.

Every ``Add to Export`` renders the final figure immediately and stores it in the
session folder.  ``Export All`` therefore only reorganises files and compresses
them; it never re-runs Matplotlib or a high resolution 3D render.
"""

from __future__ import annotations

import atexit
import json
import io
import math
import re
import xml.etree.ElementTree as ET
from PIL import Image
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from threading import RLock
from uuid import uuid4

from backend import naming
from backend.storage import state_dir, read_json, atomic_json


def _default_root() -> Path:
    return state_dir() / "exports"


EXPORT_ROOT = _default_root()
FIGURES = "figures"
MAX_ITEMS = 80
MAX_TOTAL_BYTES = 1_500_000_000
KEEP_SESSIONS = 5

MIME = {"png": "image/png", "pdf": "application/pdf", "svg": "image/svg+xml"}

_lock = RLock()
_session: "ExportSession | None" = None
_bound_folder: Path | None = None


def bind(folder):
    """Select a project's queue without deleting the previous project's figures."""
    global _session, _bound_folder
    folder = Path(folder).resolve() if folder is not None else None
    with _lock:
        if folder != _bound_folder:
            _session = None
            _bound_folder = folder


def now():
    return datetime.now().replace(microsecond=0).isoformat()


def validate_queue(value, expected_id):
    """Reject damaged metadata before restoring it or replacing its backup."""
    if (not isinstance(value, dict) or type(value["version"]) is not int
            or value["version"] != 1 or value["id"] != expected_id):
        raise ValueError("Unsupported export queue version.")
    if (not isinstance(value["created_at"], str)
            or value["dataset"] is not None and not isinstance(value["dataset"], str)):
        raise ValueError("Invalid export queue metadata.")
    datetime.fromisoformat(value["created_at"])
    if type(value["counter"]) is not int or value["counter"] < 0 or not isinstance(value["items"], list):
        raise ValueError("Invalid export queue counter or items.")
    ids, stored_names, filenames = set(), set(), set()
    for item in value["items"]:
        if not isinstance(item, dict):
            raise ValueError("Invalid export queue item.")
        for key in ("id", "filename", "stored", "dataset", "format", "view_type", "folder", "created_at", "detail"):
            if not isinstance(item[key], str):
                raise ValueError(f"Invalid figure {key}.")
        for key in ("stored", "filename"):
            name = item[key]
            if not name or name in {".", ".."} or "/" in name or "\\" in name:
                raise ValueError("Invalid figure path.")
        if not re.fullmatch(r"exp_[0-9]+", item["id"]) or item["format"] not in MIME:
            raise ValueError("Invalid figure identity or format.")
        if item["id"] in ids or item["stored"] in stored_names or item["filename"].lower() in filenames:
            raise ValueError("Duplicate figure identity or filename.")
        ids.add(item["id"])
        stored_names.add(item["stored"])
        filenames.add(item["filename"].lower())
        datetime.fromisoformat(item["created_at"])
        for key, minimum in (("serial", 1), ("index", 1), ("size_bytes", 0)):
            if type(item[key]) is not int or item[key] < minimum:
                raise ValueError(f"Invalid figure {key}.")
        for key in ("summary", "render", "view_state"):
            if not isinstance(item[key], dict):
                raise ValueError(f"Invalid figure {key}.")
        for key in ("width_mm", "height_mm", "dpi", "scale"):
            number = item[key]
            if number is not None and (type(number) not in (int, float)
                    or isinstance(number, float) and not math.isfinite(number) or number <= 0):
                raise ValueError(f"Invalid figure {key}.")
        pixels = item["pixel_size"]
        if pixels is not None and (not isinstance(pixels, (list, tuple)) or len(pixels) != 2
                or any(type(size) is not int or size <= 0 for size in pixels)):
            raise ValueError("Invalid figure pixel dimensions.")
    # Arbitrary view state and summary dictionaries must also be persistable.
    json.dumps(value, allow_nan=False)
    return value


def _prune(keep=KEEP_SESSIONS - 1):
    """Delete the oldest leftover sessions (requirement: temporary files self-clean)."""
    if not EXPORT_ROOT.exists():
        return
    folders = sorted(
        (p for p in EXPORT_ROOT.iterdir() if p.is_dir() and p.name.startswith("session_")),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for folder in folders[keep:]:
        shutil.rmtree(folder, ignore_errors=True)


def session() -> "ExportSession":
    global _session
    with _lock:
        if _session is None:
            if _bound_folder is not None:
                saved = _bound_folder / "queue.json"
                _session = ExportSession.load(_bound_folder) if saved.exists() or saved.with_suffix(".json.bak").exists() else ExportSession(_bound_folder)
                return _session
            EXPORT_ROOT.mkdir(parents=True, exist_ok=True)
            saved = sorted(
                (p for p in EXPORT_ROOT.glob("session_*") if (p / "queue.json").exists() or (p / "queue.json.bak").exists()),
                key=lambda p: p.stat().st_mtime, reverse=True,
            )
            if saved:
                _session = ExportSession.load(saved[0])
            else:
                _prune()
                _session = ExportSession()
        return _session


def queue_for_folder(folder: Path) -> "ExportSession":
    """Resolve an origin queue without changing the active project's binding.

    The caller holds the application project lock through the following update.
    Reuse the bound instance so background publication cannot leave it stale.
    """
    folder = Path(folder).resolve()
    with _lock:
        if folder == _bound_folder:
            return session()
        if (folder / "queue.json").exists() or (folder / "queue.json.bak").exists():
            return ExportSession.load(folder)
        return ExportSession(folder)


def reset():
    """Drop the current session and its temporary files (shutdown and tests)."""
    global _session
    with _lock:
        if _session is not None:
            shutil.rmtree(_session.folder, ignore_errors=True)
            _session = None


def shutdown():
    global _session, _bound_folder
    with _lock:
        _session = None
        _bound_folder = None


atexit.register(shutdown)


class ExportSession:
    def __init__(self, folder=None):
        self.id = Path(folder).name if folder else "session_" + uuid4().hex[:6]
        self.folder = Path(folder) if folder else EXPORT_ROOT / self.id
        (self.folder / FIGURES).mkdir(parents=True, exist_ok=True)
        self.created_at = now()
        self.dataset: str | None = None
        self.items: list[dict] = []
        self._names: set[str] = set()
        self._bytes = 0
        # Monotonic, so a deleted figure never gives its file prefix to a new one.
        self._counter = 0
        self._write_manifest()

    @classmethod
    def load(cls, folder):
        folder = Path(folder)
        saved = read_json(folder / "queue.json", lambda value: validate_queue(value, folder.name))
        if saved is None:
            raise ValueError("Export queue not found.")
        result = cls.__new__(cls)
        result.id, result.folder = saved["id"], folder
        result.created_at, result.dataset = saved["created_at"], saved["dataset"]
        result.items = saved["items"]
        for item in result.items:
            item["temporary_path"] = str(folder / FIGURES / item["stored"])
        result._counter = max(saved["counter"], max((h["serial"] for h in result.items), default=0))
        result._names = {item["filename"].lower() for item in result.items}
        result._bytes = sum(item["size_bytes"] for item in result.items)
        return result

    # ------------------------------------------------------------------ helpers

    def _unique(self, filename: str, ignore: str | None = None) -> str:
        taken = set(self._names)
        if ignore:
            taken.discard(ignore.lower())
        return naming.unique_name(filename, taken)

    def _find(self, item_id: str) -> dict:
        for item in self.items:
            if item["id"] == item_id:
                return item
        raise KeyError(item_id)

    def _stored(self, item: dict) -> Path:
        return self.folder / FIGURES / item["stored"]

    def _write_manifest(self) -> None:
        """Save the complete queue as well as the portable export manifest."""
        saved = {
            "version": 1, "id": self.id, "created_at": self.created_at,
            "dataset": self.dataset, "counter": self._counter, "items": self.items,
        }
        manifest = self.manifest()
        # Validate all derived metadata before committing the authoritative file.
        json.dumps(manifest, allow_nan=False)
        atomic_json(self.folder / "queue.json", saved,
                    validate=lambda value: validate_queue(value, self.id))
        try:
            # Mirror the committed queue: deleted files must not reappear from
            # an old backup. The primary document is the transaction commit.
            atomic_json(self.folder / "queue.json.bak", saved, backup=False)
            atomic_json(self.folder / "manifest.json", manifest)
        except (OSError, ValueError, TypeError):
            pass  # ZIP builds its manifest from the authoritative queue.

    def _detail(self, item: dict) -> str:
        fmt = item["format"].upper()
        if item["pixel_size"]:
            width, height = item["pixel_size"]
            return f"{fmt} · {width} × {height} px" + ("" if item["render"].get("canvas") == "fit" else f" · {item['scale']}×")
        return (
            f"{fmt} · {naming.number(item['width_mm'])} × "
            f"{naming.number(item['height_mm'])} mm · {naming.number(item['dpi'])} dpi"
        )

    def restore_item(self, item_id: str) -> dict:
        """Resolve a settings record within the already bound project queue."""
        return self._find(item_id)

    def public(self, item: dict) -> dict:
        """Queue summary without the potentially large restoration snapshot."""
        return {
            "restorable": item.get("restore") is not None,
            **{key: value
            for key, value in item.items()
            if key not in {"stored", "serial", "summary", "render", "restore"}},
        }

    # --------------------------------------------------------------------- add

    def add(
        self,
        *,
        data: bytes,
        filename: str,
        view_type: str,
        dataset: str,
        view_state: dict,
        summary: dict,
        render: dict | None = None,
        width_mm: float | None = None,
        height_mm: float | None = None,
        dpi: int | None = None,
        pixel_size: tuple[int, int] | None = None,
        scale: int | None = None,
        restore: dict | None = None,
    ) -> dict:
        if len(self.items) >= MAX_ITEMS:
            raise ValueError(f"Export queue is full ({MAX_ITEMS} figures). Export or clear it first.")
        if self._bytes + len(data) > MAX_TOTAL_BYTES:
            raise ValueError("Export session exceeds its temporary storage budget. Export the ZIP first.")
        free = shutil.disk_usage(self.folder).free
        if free < len(data) + 64 * 1024 * 1024:
            raise ValueError("Not enough temporary disk space for another figure.")

        if render and render.get("canvas") == "fit":
            fmt = Path(filename).suffix.lower()
            if fmt == ".png":
                with Image.open(io.BytesIO(data)) as image:
                    pixel_size = image.size
                    dpi = image.info.get("dpi", (300, 300))[0]
                width_mm, height_mm = [n / dpi * 25.4 for n in pixel_size]
            else:
                if fmt == ".svg":
                    root = ET.fromstring(data)
                    w = float(root.attrib["width"].removesuffix("px").removesuffix("pt"))
                    h = float(root.attrib["height"].removesuffix("px").removesuffix("pt"))
                    units = 96 if root.attrib["width"].endswith("px") else 72
                else:
                    match = re.search(rb"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]", data)
                    if not match:
                        raise ValueError("Export PDF has no page bounds.")
                    x0, y0, x1, y1 = map(float, match.groups())
                    w, h, units = x1 - x0, y1 - y0, 72
                width_mm, height_mm = w / units * 25.4, h / units * 25.4
                factor = render["long_edge"] / max(w, h)
                pixel_size = (round(w * factor), round(h * factor))
                dpi = render["long_edge"] / (max(width_mm, height_mm) / 25.4)
            scale = 1
            filename = re.sub(r"_[\d.]+x[\d.]+mm_[\d.]+dpi(?=\.)",
                              f"_{pixel_size[0]}x{pixel_size[1]}px", filename)
            render = {**render, "pixel_size": list(pixel_size), "width": width_mm,
                      "height": height_mm, "dpi": dpi}
        filename = self._unique(filename)
        serial = self._counter + 1
        item_id = f"exp_{serial:04d}"
        index = len(self.items) + 1
        stored = f"{serial:03d}_{filename}"
        path = self.folder / FIGURES / stored
        item = {
            "id": item_id,
            "index": index,
            "serial": serial,
            "dataset": dataset,
            "view_type": view_type,
            "folder": naming.zip_folder(view_type),
            "filename": filename,
            "temporary_path": str(path),
            "stored": stored,
            "format": naming.extension(Path(filename).suffix, "png"),
            "width_mm": width_mm,
            "height_mm": height_mm,
            "dpi": dpi,
            "pixel_size": list(pixel_size) if pixel_size else None,
            "scale": scale,
            "size_bytes": len(data),
            "created_at": now(),
            "view_state": view_state,
            "summary": summary,
            "render": render or {},
            "restore": restore,
        }
        item["detail"] = self._detail(item)
        # A rejected state must not leave a file or consume a figure identity.
        json.dumps(item, allow_nan=False)
        try:
            path.write_bytes(data)
        except OSError:
            path.unlink(missing_ok=True)
            raise
        self._counter = serial
        self._bytes += len(data)
        self._names.add(filename.lower())
        self.items.append(item)
        previous_dataset = self.dataset
        self.dataset = dataset
        try:
            self._write_manifest()
        except (OSError, ValueError, TypeError):
            self.items.remove(item)
            self._names.discard(filename.lower())
            self._bytes -= len(data)
            self._counter -= 1
            self.dataset = previous_dataset
            path.unlink(missing_ok=True)
            raise
        return self.public(item)

    # -------------------------------------------------------------- operations

    def get(self, item_id: str) -> dict:
        return self.public(self._find(item_id))

    def file(self, item_id: str) -> tuple[Path, str]:
        item = self._find(item_id)
        path = self._stored(item)
        if not path.is_file():
            raise KeyError(item_id)
        return path, MIME.get(item["format"], "application/octet-stream")

    def rename(self, item_id: str, filename: str) -> dict:
        item = self._find(item_id)
        ext = naming.extension(Path(item["filename"]).suffix, item["format"])
        stem = Path(str(filename)).stem if "." in str(filename) else str(filename)
        clean = naming.sanitize(stem, "Figure")
        candidate = f"{clean}.{ext}"
        if candidate.lower() == item["filename"].lower():
            return self.public(item)
        candidate = self._unique(candidate, ignore=item["filename"])
        old = self._stored(item)
        new = self.folder / FIGURES / f"{item['serial']:03d}_{candidate}"
        try:
            shutil.copyfile(old, new)
        except OSError:
            new.unlink(missing_ok=True)
            raise
        previous = dict(item)
        self._names.discard(item["filename"].lower())
        self._names.add(candidate.lower())
        item["filename"] = candidate
        item["stored"] = new.name
        item["temporary_path"] = str(new)
        item["format"] = ext
        item["detail"] = self._detail(item)
        try:
            self._write_manifest()
        except (OSError, ValueError, TypeError):
            self._names.discard(candidate.lower())
            self._names.add(previous["filename"].lower())
            item.clear()
            item.update(previous)
            new.unlink(missing_ok=True)
            raise
        old.unlink(missing_ok=True)
        return self.public(item)

    def delete(self, item_id: str) -> None:
        item = self._find(item_id)
        previous_items = self.items[:]
        self._names.discard(item["filename"].lower())
        self._bytes -= item["size_bytes"]
        self.items.remove(item)
        # Renumbering would invalidate stored prefixes, so keep the queue order
        # and only refresh the visible position of the remaining figures.
        for position, remaining in enumerate(self.items, 1):
            remaining["index"] = position
        try:
            self._write_manifest()
        except (OSError, ValueError, TypeError):
            self.items = previous_items
            self._names.add(item["filename"].lower())
            self._bytes += item["size_bytes"]
            for position, remaining in enumerate(self.items, 1):
                remaining["index"] = position
            raise
        self._stored(item).unlink(missing_ok=True)

    def clear(self) -> None:
        previous = (self.items, self._names, self._bytes, self._counter, self.dataset)
        self.items = []
        self._names = set()
        self._bytes = 0
        self.dataset = None
        try:
            self._write_manifest()
        except (OSError, ValueError, TypeError):
            self.items, self._names, self._bytes, self._counter, self.dataset = previous
            raise
        shutil.rmtree(self.folder / FIGURES, ignore_errors=True)
        (self.folder / FIGURES).mkdir(parents=True, exist_ok=True)

    def snapshot(self) -> dict:
        return {
            "session": self.id,
            "dataset": self.dataset,
            "count": len(self.items),
            "created_at": self.created_at,
            "items": [self.public(item) for item in self.items],
        }

    # ----------------------------------------------------------------- manifest

    def manifest(self, items: list[dict] | None = None) -> dict:
        datasets: list[str] = []
        figures = []
        for number, item in enumerate(self.items if items is None else items, 1):
            if item["dataset"] not in datasets:
                datasets.append(item["dataset"])
            folder = naming.zip_folder(item["view_type"])
            archive_path = f"{folder}/{item['filename']}" if folder else item["filename"]
            figures.append(
                {
                    **item["summary"],
                    "id": number,
                    "name": item["filename"],
                    "file": archive_path,
                    "view": item["view_type"],
                    "dataset": item["dataset"],
                    "format": item["format"],
                    "width_mm": item["width_mm"],
                    "height_mm": item["height_mm"],
                    "dpi": item["dpi"],
                    "pixel_size": item["pixel_size"],
                    "scale": item["scale"],
                    "created_at": item["created_at"],
                    "render": item["render"],
                    "view_state": item["view_state"],
                    "restore": item.get("restore"),
                }
            )
        return {
            "application": "SeisCanvas",
            "version": "0.1",
            "session": self.id,
            "created_at": self.created_at,
            "exported_at": now(),
            "dataset": datasets[0] if len(datasets) == 1 else None,
            "datasets": datasets,
            "figure_count": len(figures),
            "figures": figures,
        }

    def archive(self, item_ids: list[str] | None = None) -> tuple[Path, str, dict]:
        if not self.items:
            raise ValueError("Export queue is empty.")
        if item_ids is None:
            items = self.items
        else:
            if not item_ids or len(item_ids) != len(set(item_ids)):
                raise ValueError("Select at least one figure, without duplicate items.")
            for item_id in item_ids:
                self._find(item_id)
            selected = set(item_ids)
            items = [item for item in self.items if item["id"] in selected]
        manifest = self.manifest(items)
        dataset = manifest["dataset"]
        prefix = f"SeisCanvas_{dataset}_Export" if dataset else "SeisCanvas_BatchExport"
        filename = f"{prefix}_{datetime.now().strftime('%Y%m%d_%H%M')}.zip"

        path = self.folder / f"_archive_{uuid4().hex[:8]}.zip"
        try:
            with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                for item, figure in zip(items, manifest["figures"]):
                    archive.write(self._stored(item), figure["file"])
                archive.writestr(
                    "export_manifest.json",
                    json.dumps(manifest, ensure_ascii=False, allow_nan=False, indent=2),
                )
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return path, filename, manifest
