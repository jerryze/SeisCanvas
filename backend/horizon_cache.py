"""Atomic, memory-mapped parsed horizon cache, keyed by file identity and columns."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import numpy as np

CACHE_DIR = Path(__file__).resolve().parents[1] / '.cache' / 'horizons'


def cache_path(path, columns):
    path = Path(path).resolve()
    stat = path.stat()
    identity = [1, str(path), stat.st_size, stat.st_mtime_ns, list(columns)]
    return CACHE_DIR / (hashlib.sha256(json.dumps(identity).encode()).hexdigest() + '.npy')


def load_cached(path):
    try:
        data = np.load(path, mmap_mode='c', allow_pickle=False)
        return data if data.ndim == 2 and data.shape[1] == 3 else None
    except (OSError, ValueError, EOFError):
        return None


def save_cached(path, data):
    temporary = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.npy', delete=False) as f:
            temporary = f.name
            np.save(f, data, allow_pickle=False)
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
