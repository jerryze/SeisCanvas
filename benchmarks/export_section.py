"""Reproduce the removed 2D export work without queue or SEG-Y disk I/O.

Run from the project root with ``.venv/bin/python benchmarks/export_section.py``.
The baseline keeps the original queue preparation order and retains its first
polarity-adjusted section while the compatible bytes-only renderer works. Both
paths use the current renderer, so this isolates duplicated amplitude preparation
instead of comparing different figure layouts or sampling algorithms.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import sys
import tempfile
from time import perf_counter
import tracemalloc

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "seiscanvas-mpl"))

import matplotlib
import numpy as np

from backend.models import Seismic, Settings, ViewState
from backend.rendering import SectionRenderResult, amplitude, render, render_with_metadata


@dataclass
class SyntheticSurvey:
    x: np.ndarray
    time: np.ndarray
    samples: np.ndarray

    def section(self, mode, number):
        return self.x, self.time, self.samples


def baseline(survey, state, settings):
    """The original add_2d preprocessing followed by the bytes-only renderer."""
    section = survey.section(state.view_type, state.section_number)
    _adjusted, lo, hi = amplitude(section[2], state.seismic)
    # Keep _adjusted in this frame until render returns, as the old local `_`
    # did: reverse polarity otherwise loses an entire section allocation here.
    data = render(survey, {}, state, settings)
    return SectionRenderResult(data, (lo, hi))


def current(survey, state, settings):
    return render_with_metadata(survey, {}, state, settings)


def measure(rows=2048, columns=2048, repeats=5, long_edge=600, seed=42,
            reverse_polarity=True, clip_percentile=99.5):
    samples = np.random.default_rng(seed).normal(size=(rows, columns)).astype(np.float32)
    survey = SyntheticSurvey(np.arange(columns), np.arange(rows), samples)
    state = ViewState(section_number=1, seismic=Seismic(
        reverse_polarity=reverse_polarity, clip_percentile=clip_percentile,
    ))
    settings = Settings(canvas="fit", long_edge=long_edge)
    pipelines = {"baseline": baseline, "current": current}
    # Warm both paths and check the immutable figure and its exact colour scale.
    reference, result = (pipeline(survey, state, settings) for pipeline in pipelines.values())
    assert reference.data == result.data, "PNG bytes changed"
    np.testing.assert_array_equal(reference.colorbar_range, result.colorbar_range)
    digest = hashlib.sha256(result.data).hexdigest()
    colorbar_range = list(result.colorbar_range)
    del reference, result

    timings = {name: [] for name in pipelines}
    for repeat in range(repeats):
        order = ("baseline", "current") if repeat % 2 == 0 else ("current", "baseline")
        for name in order:
            gc.collect()
            started = perf_counter()
            pipelines[name](survey, state, settings)
            timings[name].append((perf_counter() - started) * 1000)

    peaks = {}
    for name, pipeline in pipelines.items():
        gc.collect()
        tracemalloc.start()
        try:
            pipeline(survey, state, settings)
            peaks[name] = tracemalloc.get_traced_memory()[1] / 1024**2
        finally:
            tracemalloc.stop()
    median = {name: statistics.median(values) for name, values in timings.items()}
    return {
        "benchmark": "2D section rendering and amplitude metadata preparation",
        "environment": {"python": platform.python_version(), "numpy": np.__version__,
                        "matplotlib": matplotlib.__version__, "platform": platform.platform()},
        "input": {"shape": [rows, columns], "dtype": str(samples.dtype),
                  "native_mib": samples.nbytes / 1024**2, "seed": seed,
                  "reverse_polarity": reverse_polarity, "clip_percentile": clip_percentile,
                  "long_edge": long_edge, "queue_disk_io": False, "segy_disk_io": False},
        "equivalence": {"png_bytes_equal": True, "colorbar_range_equal": True,
                        "png_sha256": digest, "colorbar_range": colorbar_range},
        "repeats": repeats,
        "milliseconds": {name: {"median": median[name], "runs": values}
                         for name, values in timings.items()},
        "peak_traced_temporary_mib": peaks,
        "median_reduction_percent": (1 - median["current"] / median["baseline"]) * 100,
        "peak_reduction_mib": peaks["baseline"] - peaks["current"],
        "scope": "Warm synthetic native section; excludes file access, queue persistence and browser work. "
                 "Memory is tracemalloc peak allocation after native data creation, not process RSS.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=2048)
    parser.add_argument("--columns", type=int, default=2048)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--long-edge", type=int, default=600)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--clip-percentile", type=float, default=99.5)
    parser.add_argument("--reverse-polarity", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--output", type=Path, default=ROOT / "output/refactor-qa/export-section.json")
    args = parser.parse_args()
    if args.rows < 2 or args.columns < 2 or args.repeats < 1:
        parser.error("rows and columns must be at least 2; repeats must be positive")
    result = measure(args.rows, args.columns, args.repeats, args.long_edge, args.seed,
                     args.reverse_polarity, args.clip_percentile)
    encoded = json.dumps(result, allow_nan=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
