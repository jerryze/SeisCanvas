"""Compare exact slice results, timings, and process RSS in isolated workers.

Example (the baseline root must contain its frozen ``backend`` directory)::

    .venv/bin/python benchmarks/slice_memory.py --variant baseline --baseline-root /tmp/baseline
    .venv/bin/python benchmarks/slice_memory.py --variant current

The first command saves fixture locations in the output manifest; the second
reuses those same immutable synthetic SEG-Y files. Each case runs in a new
process. RSS includes native allocations and mapped resident file pages; this
is deliberately not a Python-only allocation benchmark. Generated fixture
files live in a dedicated temporary directory, whose location is recorded.
"""
from __future__ import annotations

import argparse
import ctypes
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import subprocess
import sys
import tempfile
from threading import Event, Thread
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024 ** 2


class _MachTime(ctypes.Structure):
    _fields_ = [("seconds", ctypes.c_int32), ("microseconds", ctypes.c_int32)]


class _MachInfo(ctypes.Structure):
    _fields_ = [("virtual_size", ctypes.c_uint64), ("resident_size", ctypes.c_uint64),
               ("resident_size_max", ctypes.c_uint64), ("user_time", _MachTime),
               ("system_time", _MachTime), ("policy", ctypes.c_int32), ("suspend_count", ctypes.c_int32)]


_MACH = ctypes.CDLL("/usr/lib/libSystem.B.dylib") if sys.platform == "darwin" else None


def resident_bytes():
    if sys.platform == "darwin":
        info = _MachInfo()
        count = ctypes.c_uint32(ctypes.sizeof(info) // 4)
        code = _MACH.task_info(_MACH.mach_task_self(), 20, ctypes.byref(info), ctypes.byref(count))
        if code:
            raise RuntimeError(f"task_info failed: {code}")
        return info.resident_size
    if sys.platform.startswith("linux"):
        return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    raise RuntimeError("RSS sampling supports macOS and Linux")


def high_water_bytes():
    maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(maximum if sys.platform == "darwin" else maximum * 1024)


class MemorySample:
    def __init__(self):
        self.before = resident_bytes()
        self.peak = self.before
        self.hwm_before = high_water_bytes()
        self.stop = Event()
        self.thread = Thread(target=self._sample, daemon=True)

    def _sample(self):
        while not self.stop.wait(0.002):
            self.peak = max(self.peak, resident_bytes())

    def start(self):
        self.thread.start()
        self.started = perf_counter()

    def finish(self):
        elapsed = (perf_counter() - self.started) * 1000
        after = resident_bytes()
        self.peak = max(self.peak, after)
        self.stop.set()
        self.thread.join()
        hwm = high_water_bytes()
        return {"milliseconds": elapsed, "rss_before_mib": self.before / MIB,
                "rss_after_mib": after / MIB, "sampled_peak_rss_mib": self.peak / MIB,
                "sampled_extra_peak_mib": max(0, self.peak - self.before) / MIB,
                "process_lifetime_peak_rss_mib": hwm / MIB,
                "new_lifetime_high_water_mib": max(0, hwm - self.hwm_before) / MIB}


def array_hash(values):
    import numpy as np
    array = np.asarray(values, dtype="<f8")
    array = np.array(array, copy=True)
    array[np.isnan(array)] = np.nan
    digest = hashlib.sha256()
    digest.update(str(array.shape).encode())
    digest.update(array.tobytes())
    return digest.hexdigest()


def extract_arrays(result, case):
    import numpy as np
    if case == "export":
        from PIL import Image
        import io
        with Image.open(io.BytesIO(result["png"])) as picture:
            return {"rgba_pixels": np.asarray(picture.convert("RGBA"))}
    if case.startswith("scene"):
        arrays = {}
        for index, item in enumerate(result["slices"]):
            for key in ("amplitude", "a", "b", "a_edges", "b_edges"):
                arrays[f"slice_{index}_{key}"] = np.asarray(item[key], dtype=float)
        return arrays
    if case == "section":
        return {key: np.asarray(result[key], dtype=float)
                for key in ("z", "x", "time", "x_edges", "time_edges")}
    return {"probe": np.asarray([result["amplitude"], result["inline"],
                                 result["crossline"], result["time"]], dtype=float)}


def worker(config):
    sys.path.insert(0, config["code_root"])
    state_root = Path(config["worker_state"])
    os.environ["SEISCANVAS_STATE_DIR"] = str(state_root / "state")
    os.environ["MPLCONFIGDIR"] = str(state_root / "matplotlib")
    import numpy as np
    from backend import geometry, horizon_cache
    geometry.CACHE_DIR = Path(config["geometry_cache"])
    horizon_cache.CACHE_DIR = state_root / "horizons"
    from backend.segy import Survey
    from backend.scene import scene_data
    from backend.section_service import interactive_section
    from backend.models import SampleRequest, SectionRequest, Settings, ViewState, ViewState3D
    from backend.rendering import render_with_metadata
    from backend import main as server

    gc.collect()
    memory = MemorySample()
    memory.start()
    survey = Survey(config["source"], ilbyte=config.get("ilbyte", 189), xlbyte=config.get("xlbyte", 21))
    geometry_metrics = memory.finish()
    server.survey = survey
    server.horizons = {}
    gc.collect()
    geometry_rss = resident_bytes()
    ils, xls, times = survey.inlines, survey.crosslines, survey.times
    il, xl, time = int(ils[len(ils) // 2]), int(xls[len(xls) // 2]), float(times[len(times) // 2])
    width, height = config["width"], config["height"]
    case = config["case"]
    seismic = {"clip_percentile": 99.5, "symmetric": True,
               "background_interpolation": True, "wiggle": False, "variable_area": False}
    if case.startswith("scene"):
        slices = {"inline": [], "crossline": [], "time": []}
        if case == "scene_multi":
            # Two full vertical sections and a fixed-TWT plane. The production
            # scene_data always passes seismic settings to its slice reader.
            for index, value in enumerate((ils[0], ils[-1])):
                slices["inline"].append({"id": f"il-{index}", "position": int(value)})
        slices["time"].append({"id": "time", "position": time})
        state = ViewState3D.model_validate({"view_mode": "3d", "seismic": seismic,
            "slices": slices, "scene": {"quality": 256,
                "slice_viewports": {item["id"]: [width, height] for values in slices.values() for item in values}}})
        operation = lambda: scene_data(survey, {}, state)
    elif case == "export":
        state = ViewState(section_number=il, seismic=seismic)
        settings = Settings(canvas="fit", long_edge=800, font="DejaVu Sans")
        def operation():
            rendered = render_with_metadata(survey, {}, state, settings)
            return {"png": rendered.data, "vmin": rendered.colorbar_range[0], "vmax": rendered.colorbar_range[1]}
    elif case == "section":
        request = SectionRequest(section_number=il, seismic=seismic,
                                 target_width=width, target_height=height)
        operation = lambda: interactive_section(survey, {}, request)
    else:
        request = SampleRequest(kind="inline", position=il, crossline=xl, time=time)
        operation = lambda: server.sample(request)

    runs = []
    expected = None
    first_arrays = None
    for iteration in range(1 + config["warm_repeats"]):
        gc.collect()
        memory = MemorySample()
        memory.start()
        result = operation()
        metrics = memory.finish()
        arrays = extract_arrays(result, case)
        hashes = {key: array_hash(value) for key, value in arrays.items()}
        colorbar = [result["vmin"], result["vmax"]] if "vmin" in result else None
        signature = {"array_hashes": hashes, "colorbar": colorbar}
        if expected is None:
            expected = signature
            first_arrays = arrays
            if case == "export":
                image_path = Path(config["arrays_output"]).with_suffix(".png")
                image_path.parent.mkdir(parents=True, exist_ok=True)
                image_path.write_bytes(result["png"])
        elif signature != expected:
            raise AssertionError("Warm request changed exact scientific output")
        metrics["phase"] = "cold" if iteration == 0 else "warm"
        metrics["sampled_peak_above_loaded_geometry_mib"] = max(0, metrics["sampled_peak_rss_mib"] - geometry_rss / MIB)
        runs.append(metrics)
        del result, arrays
    output_arrays = Path(config["arrays_output"])
    output_arrays.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(output_arrays, **first_arrays)
    return {
        "dataset": config["dataset"], "case": case,
        "source": config["source"], "source_bytes": Path(config["source"]).stat().st_size,
        "native_shape": [len(ils), len(xls), len(times)],
        "requested_output": {"long_edge": 800} if case == "export" else [width, height], "geometry": geometry_metrics,
        "rss_after_geometry_mib": geometry_rss / MIB,
        "runs": runs, **expected,
        "array_shapes": {key: list(value.shape) for key, value in first_arrays.items()},
        "array_file": str(output_arrays), "code_root": config["code_root"],
        "geometry_cache_hit": bool(survey.geometry_cached),
        "environment": {"python": platform.python_version(), "numpy": np.__version__, "platform": platform.platform()},
    }


def make_fixture(path, *, traces=None, sparse_axis=None, samples=2048, seed=42):
    import numpy as np
    import segyio
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return
    rng = np.random.default_rng(seed)
    spec = segyio.spec()
    spec.sorting, spec.format = 2, 5
    spec.samples = list(range(0, 2 * samples, 2))
    if sparse_axis:
        spec.tracecount = sparse_axis
        coordinates = ((100 + index, 1000 + index) for index in range(sparse_axis))
    else:
        spec.ilines = [100, 101, 102]
        spec.xlines = list(range(1000, 1000 + traces))
        coordinates = ((inline, crossline) for inline in spec.ilines for crossline in spec.xlines)
    time = np.arange(samples, dtype=np.float32) * 0.05
    with segyio.create(str(path), spec) as stream:
        for index, (inline, crossline) in enumerate(coordinates):
            stream.header[index] = {189: inline, 21: crossline, 193: crossline, 109: 0, 117: 2000}
            stream.trace[index] = (np.sin(time + crossline * 0.013) + 0.3 * rng.standard_normal(samples)).astype(np.float32)
        stream.bin[segyio.BinField.Interval] = 2000


def manifest_for(args):
    path = args.output_dir / "fixtures.json"
    if path.exists():
        manifest = json.loads(path.read_text())
        if args.data_dir:
            manifest["data_dir"] = str(args.data_dir.resolve())
            for item in manifest["datasets"]:
                if not item.get("external"):
                    item["path"] = str(args.data_dir.resolve() / f"{item['name']}.segy")
    else:
        data_dir = args.data_dir.resolve() if args.data_dir else Path(tempfile.mkdtemp(prefix="seiscanvas-slice-fixtures-"))
        manifest = {"data_dir": str(data_dir), "datasets": []}
        for name, traces in (("dense-small", 2048), ("dense-large", 8192)):
            manifest["datasets"].append({"name": name, "path": str(data_dir / f"{name}.segy"),
                                         "traces": traces, "samples": 2048,
                                         "cases": ["section", "scene_multi", "probe"]})
        for name, axis in (("sparse-small", 4096), ("sparse-large", 8192)):
            manifest["datasets"].append({"name": name, "path": str(data_dir / f"{name}.segy"),
                                         "sparse_axis": axis, "samples": 32, "cases": ["scene_time"]})
    if args.real_segy:
        resolved = str(args.real_segy.resolve())
        existing = next((item for item in manifest["datasets"] if item["name"] == "F3"), None)
        if existing is not None:
            existing["path"] = resolved
        else:
            manifest["datasets"].append({"name": "F3", "path": resolved,
                                         "cases": ["section", "scene_multi", "scene_time", "probe"], "external": True})
    for dataset in manifest["datasets"]:
        if dataset["name"] in {"dense-small", "F3"} and "export" not in dataset["cases"]:
            dataset["cases"].append("export")
    for dataset in manifest["datasets"]:
        if not dataset.get("external"):
            make_fixture(Path(dataset["path"]), **{key: dataset[key] for key in ("traces", "sparse_axis", "samples") if key in dataset})
    args.output_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


def compare(output_dir):
    import numpy as np
    paths = [output_dir / f"{variant}.json" for variant in ("baseline", "current")]
    if not all(path.exists() for path in paths):
        return None
    before, after = [json.loads(path.read_text()) for path in paths]
    originals = {(item["dataset"], item["case"]): item for item in before["results"]}
    updated_keys = {(item["dataset"], item["case"]) for item in after["results"]}
    same_case_keys = set(originals) == updated_keys
    comparison = []
    for item in after["results"]:
        previous = originals.get((item["dataset"], item["case"]))
        if previous is None:
            continue
        values = []
        with np.load(previous["array_file"]) as old, np.load(item["array_file"]) as new:
            same_array_keys = set(old.files) == set(new.files)
            for key in old.files:
                if key not in new.files:
                    values.append({"name": key, "exact_equal": False,
                                   "max_abs_finite_difference": None, "same_nan_mask": False})
                    continue
                a, b = old[key], new[key]
                equal = np.array_equal(a, b, equal_nan=True)
                difference = np.abs(a.astype(float) - b.astype(float)) if a.shape == b.shape else np.array([])
                finite = difference[np.isfinite(difference)]
                values.append({"name": key, "exact_equal": equal,
                               "max_abs_finite_difference": float(finite.max()) if finite.size else None,
                               "same_nan_mask": a.shape == b.shape and bool(np.array_equal(np.isnan(a), np.isnan(b)))})
        comparison.append({"dataset": item["dataset"], "case": item["case"],
            "same_array_keys": same_array_keys,
            "colorbar_exact_equal": previous["colorbar"] == item["colorbar"],
            "arrays": values,
            "cold_before": previous["runs"][0], "cold_after": item["runs"][0],
            "warm_before": previous["runs"][1:], "warm_after": item["runs"][1:]})
    result = {"comparisons": comparison, "same_case_keys": same_case_keys,
              "all_scientific_outputs_exact": bool(comparison) and same_case_keys and all(
                  row["same_array_keys"] and row["colorbar_exact_equal"]
                  and all(a["exact_equal"] for a in row["arrays"]) for row in comparison)}
    (output_dir / "comparison.json").write_text(json.dumps(result, allow_nan=False, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--variant", choices=["baseline", "current", "both"], default="both")
    parser.add_argument("--baseline-root", type=Path)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "output/slice-memory-qa")
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--real-segy", type=Path)
    parser.add_argument("--dataset", action="append")
    parser.add_argument("--case", action="append")
    parser.add_argument("--warm-repeats", type=int, default=2)
    parser.add_argument("--width", type=int, default=256)
    parser.add_argument("--height", type=int, default=192)
    args = parser.parse_args()
    if args.worker:
        config = json.loads(args.worker.read_text())
        result = worker(config)
        Path(config["result_output"]).write_text(json.dumps(result, allow_nan=False, indent=2) + "\n")
        return
    args.output_dir = args.output_dir.resolve()
    if args.variant in {"baseline", "both"} and (not args.baseline_root or not (args.baseline_root / "backend").is_dir()):
        parser.error("--baseline-root must contain the frozen backend directory")
    if args.warm_repeats < 1 or min(args.width, args.height) < 8:
        parser.error("warm-repeats must be positive and output dimensions at least 8")
    manifest = manifest_for(args)
    variants = ["baseline", "current"] if args.variant == "both" else [args.variant]
    for variant in variants:
        result_path = args.output_dir / f"{variant}.json"
        previous = json.loads(result_path.read_text())["results"] if result_path.exists() else []
        results = {(item["dataset"], item["case"]): item for item in previous}
        for dataset in manifest["datasets"]:
            if args.dataset and dataset["name"] not in args.dataset:
                continue
            for case in dataset["cases"]:
                if args.case and case not in args.case:
                    continue
                print(f"Measuring {variant}: {dataset['name']}/{case}", file=sys.stderr, flush=True)
                stem = f"{variant}-{dataset['name']}-{case}"
                code_root = args.baseline_root.resolve() if variant == "baseline" else ROOT
                config = {"code_root": str(code_root), "dataset": dataset["name"], "source": dataset["path"],
                    "case": case, "width": args.width, "height": args.height, "warm_repeats": args.warm_repeats,
                    "worker_state": str(Path(manifest["data_dir"]) / "workers" / stem),
                    "geometry_cache": str(Path(manifest["data_dir"]) / "geometry"),
                    "arrays_output": str(args.output_dir / "arrays" / f"{stem}.npz"),
                    "result_output": str(args.output_dir / "measurements" / f"{stem}.json")}
                config_path = Path(manifest["data_dir"]) / f"{stem}.json"
                config_path.write_text(json.dumps(config))
                Path(config["result_output"]).parent.mkdir(parents=True, exist_ok=True)
                subprocess.run([sys.executable, str(Path(__file__).resolve()), "--worker", str(config_path)],
                               check=True, cwd=code_root, timeout=600)
                measured = json.loads(Path(config["result_output"]).read_text())
                results[(dataset["name"], case)] = measured
                report = {"variant": variant, "results": list(results.values()),
                    "scope": ["Each case uses a fresh worker; baseline and current share the same source file and geometry-cache directory.",
                        "RSS sampler uses current resident memory every 2 ms. Very brief spikes can be missed; the OS lifetime high-water mark is reported separately.",
                        "Additional operation peak is relative to current RSS after geometry loading; full-process RSS also includes imports and geometry.",
                        "Cold means first slice request in this worker, not cold filesystem caches. Warm requests reuse process caches.",
                        "Calls execute the actual scene_data, interactive_section, or probe endpoint function. HTTP JSON encoding, transport, and browser work are excluded.",
                        "RSS includes mapped resident source pages; output hash construction and compressed artifact writing occur outside timed/sampled operations.",
                        "Scientific checks compare original percentile colour bounds and every returned raster/coordinate value, including missing-sample masks."]}
                result_path.write_text(json.dumps(report, allow_nan=False, indent=2) + "\n")
                first = measured["runs"][0]
                print(f"  cold {first['milliseconds']:.1f} ms; extra RSS {first['sampled_extra_peak_mib']:.1f} MiB; process peak {first['process_lifetime_peak_rss_mib']:.1f} MiB", flush=True)
    compared = compare(args.output_dir)
    if compared:
        print("Exact scientific equivalence:", compared["all_scientific_outputs_exact"])


if __name__ == "__main__":
    main()
