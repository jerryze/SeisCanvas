"""Local application storage and atomic, recoverable JSON documents."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile


def state_dir() -> Path:
    override = os.environ.get("SEISCANVAS_STATE_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/SeisCanvas"
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "SeisCanvas"
    return Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "seiscanvas"


def read_json(path: Path, validate=lambda value: value):
    """Use the last valid backup when a document is incomplete or damaged."""
    for candidate in (path, path.with_suffix(path.suffix + ".bak")):
        try:
            return validate(json.loads(candidate.read_text(encoding="utf-8")))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    if path.exists() or path.with_suffix(path.suffix + ".bak").exists():
        raise ValueError(f"保存文件损坏，原文件已保留：{path}")
    return None


def atomic_json(path: Path, value, *, backup=True) -> None:
    """Flush a complete document before replacing the visible file."""
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        if backup and path.is_file():
            # Never replace the last good backup with a corrupt primary file.
            try:
                previous = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                previous = None
            if previous is not None:
                atomic_json(path.with_suffix(path.suffix + ".bak"), previous, backup=False)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
