from pathlib import Path

import numpy as np
import pytest
import segyio
from fastapi.testclient import TestClient

from backend.core import Horizon, Survey
from backend import export_queue


@pytest.fixture
def cube(tmp_path):
    """A 2 inline x 3 crossline x 4 sample cube used across the test suite."""
    path = tmp_path / "tiny.segy"
    spec = segyio.spec()
    spec.sorting = 2
    spec.format = 5
    spec.samples = [200, 204, 208, 212]
    spec.ilines = [10, 12]
    spec.xlines = [30, 33, 38]
    with segyio.create(str(path), spec) as f:
        k = 0
        for il in spec.ilines:
            for xl in spec.xlines:
                f.header[k] = {189: il, 21: xl, 193: xl, 109: 200, 117: 4000}
                f.trace[k] = np.arange(4, dtype=np.float32) + il * 100 + xl
                k += 1
        f.bin[segyio.BinField.Interval] = 4000
    return Survey(path)


@pytest.fixture
def horizon(tmp_path):
    path = tmp_path / "h.txt"
    path.write_text("10 30 204\n10 33 205\n12 30 206\n12 33 208\n")
    return Horizon(path)


@pytest.fixture(autouse=True)
def clean_export_session(tmp_path, monkeypatch):
    """Keep tests isolated from the user's saved project and export queue."""
    import backend.main as server
    from backend.workspace import WorkspaceStore

    monkeypatch.setattr(export_queue, "EXPORT_ROOT", tmp_path / "state/exports")
    monkeypatch.setattr(server, "project", WorkspaceStore(tmp_path / "state"))
    monkeypatch.setattr(server, "restored_project", None)
    monkeypatch.setattr(server, "survey", None)
    monkeypatch.setattr(server, "horizons", {})
    export_queue.reset()
    yield
    export_queue.reset()

def make_horizon(tmp_path, hole=False):
    """A 5x5 regular horizon file; ``hole`` drops one pick to test gaps."""
    p = tmp_path / "h.txt"
    p.write_text(
        "\n".join(
            f"{y} {x} {200+2*y+x}"
            for y in range(5)
            for x in range(5)
            if not (hole and (y, x) == (1, 1))
        )
    )
    return Horizon(p)


@pytest.fixture
def client(cube, horizon):
    """TestClient against the shared module state, with one horizon loaded."""
    import backend.main as server

    server.survey = cube
    server.horizons.clear()
    server.horizons["h"] = horizon
    return TestClient(server.app)


@pytest.fixture
def wide_cube(tmp_path):
    """A 5 inline x 20 crossline x 20 sample cube for windowing tests."""
    path = tmp_path / "wide.segy"
    spec = segyio.spec()
    spec.sorting = 2
    spec.format = 5
    spec.samples = list(range(200, 200 + 4 * 20, 4))
    spec.ilines = list(range(10, 10 + 2 * 5, 2))
    spec.xlines = list(range(30, 30 + 3 * 20, 3))
    with segyio.create(str(path), spec) as f:
        k = 0
        for il in spec.ilines:
            for xl in spec.xlines:
                f.header[k] = {189: il, 21: xl, 193: xl, 109: 200, 117: 4000}
                f.trace[k] = np.arange(len(spec.samples), dtype=np.float32) + il * 100 + xl
                k += 1
        f.bin[segyio.BinField.Interval] = 4000
    return Survey(path)
