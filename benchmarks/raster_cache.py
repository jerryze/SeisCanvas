"""Measure background reconstruction reuse across four trace-style settings.

Run from the repository root with the project's Python environment, for example:
    .venv/bin/python benchmarks/raster_cache.py
    .venv/bin/python benchmarks/raster_cache.py --segy /absolute/survey.segy --output result.json

The default is deterministic synthetic data. Optional SEG-Y reads use a
temporary geometry cache, never the application project or workspace state.
Native section I/O is completed before timing the four display requests.
"""

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
from time import perf_counter
from types import SimpleNamespace

# Direct script execution places benchmarks/, rather than the repo, on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@contextmanager
def source_section(path=None, inline=None):
    import numpy as np
    from backend import geometry
    from backend.segy import ArrayCache, Survey

    if path is None:
        x = np.arange(896, dtype=float) + 310
        time = np.arange(256, dtype=float) * 4 + 200
        phase = np.arange(256, dtype=np.float32)[:, None] * np.float32(.17)
        trace = np.arange(896, dtype=np.float32)[None, :] * np.float32(.013)
        native = np.sin(phase + trace) + np.float32(.3) * np.cos(phase * np.float32(2.3) - trace)
        survey = SimpleNamespace(render_cache=ArrayCache(max_bytes=96 * 1024 * 1024))
        yield survey, x, time, native, {"source": "synthetic", "section_number": 0}
        return

    path = path.expanduser().resolve()
    previous_cache = geometry.CACHE_DIR
    with tempfile.TemporaryDirectory(prefix="seiscanvas-raster-geometry-") as directory:
        geometry.CACHE_DIR = Path(directory)
        try:
            started = perf_counter()
            survey = Survey(path)
            open_seconds = perf_counter() - started
            number = int(survey.inlines[len(survey.inlines) // 2]) if inline is None else inline
            x, time, native = survey.section("inline", number)
            yield survey, x, time, native, {
                "source": "segy", "filename": path.name, "section_number": number,
                "file_bytes": path.stat().st_size, "geometry_cache": "isolated_temporary",
                "geometry_cached": survey.geometry_cached, "open_seconds": open_seconds,
            }
        finally:
            geometry.CACHE_DIR = previous_cache


def benchmark(path=None, inline=None, width=900, height=600):
    import numpy as np
    from backend import resample
    from backend.models import Seismic, ViewState
    from backend.section_service import section_raster

    with source_section(path, inline) as (survey, x, time, native, metadata):
        calls, seconds, sequence = [], [], []
        original = resample.seismic_raster

        def reconstruct(*args, **kwargs):
            calls.append(True)
            return original(*args, **kwargs)

        reference = None
        resample.seismic_raster = reconstruct
        try:
            for polarity, wiggle in [(False, False), (False, True), (True, False), (True, True)]:
                state = ViewState(section_number=metadata["section_number"], seismic=Seismic(
                    reverse_polarity=polarity, wiggle_interpolation=wiggle,
                ))
                started = perf_counter()
                display = section_raster(survey, x, time, native, state, width, height,
                                         cache_id=("inline", state.section_number))
                seconds.append(perf_counter() - started)
                if reference is None:
                    reference = display["values"]
                else:
                    np.testing.assert_array_equal(display["values"], reference)
                sequence.append({"reverse_polarity": polarity, "wiggle_interpolation": wiggle})
        finally:
            resample.seismic_raster = original
        return {
            **metadata, "native_shape": list(native.shape), "targets": [width, height],
            "preview_shape": display["preview_shape"], "sequence": sequence,
            "reconstruction_calls": len(calls), "request_seconds": seconds,
            "total_request_seconds": sum(seconds), "all_rasters_equal": True,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--segy", type=Path, help="Read one inline from this SEG-Y; omitted uses synthetic data.")
    parser.add_argument("--inline", type=int, help="Inline number; defaults to the middle inline.")
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=600)
    parser.add_argument("--baseline", type=Path, help="Optional JSON from a previous run for comparison.")
    parser.add_argument("--output", type=Path, help="Also save the result as JSON.")
    args = parser.parse_args()
    if args.width < 1 or args.height < 1:
        parser.error("Target dimensions must be positive.")
    # Font discovery stays inside the temporary benchmark environment as well.
    with tempfile.TemporaryDirectory(prefix="seiscanvas-raster-mpl-") as directory:
        os.environ.setdefault("MPLCONFIGDIR", directory)
        result = benchmark(args.segy, args.inline, args.width, args.height)
    if args.baseline:
        baseline = json.loads(args.baseline.read_text())
        result = {
            "baseline": baseline, "current": result,
            "comparison": {
                "matching_shape_and_target": baseline["native_shape"] == result["native_shape"]
                and baseline["targets"] == result["targets"],
                "avoided_reconstructions": baseline["reconstruction_calls"] - result["reconstruction_calls"],
                "baseline_total_seconds": sum(baseline["request_seconds"]),
                "current_total_seconds": result["total_request_seconds"],
                "note": "Wall times are one local run; reconstruction counts are the reproducible invariant.",
            },
        }
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
