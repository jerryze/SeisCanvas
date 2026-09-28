from pathlib import Path

import numpy as np
import pytest
import segyio

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
def clean_export_session():
    """Every test starts and ends with an empty, removed export session."""
    export_queue.reset()
    yield
    export_queue.reset()
