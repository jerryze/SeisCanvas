"""Measure section HTTP latency while a real figure export is in progress.

Run from the project root with ``.venv/bin/python benchmarks/background_export.py``.
The benchmark starts its own server and creates a small synthetic SEG-Y in a
temporary directory. It never opens or changes the user's workspace. The old
synchronous queue endpoint is compared with the background-job endpoint using
the same render request. Section data is warmed before measuring contention.

This measures HTTP response latency, including JSON encoding and network I/O;
it does not measure browser painting or claim performance on a large survey.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import platform
import re
import socket
import statistics
import subprocess
import sys
import tempfile
import threading
from time import perf_counter, sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TERMINAL = {"completed", "failed", "cancelled"}


def synthetic_segy(path, samples, traces, seed):
    import numpy as np
    import segyio

    rng = np.random.default_rng(seed)
    spec = segyio.spec()
    spec.sorting, spec.format = 2, 5
    spec.samples = list(range(0, samples * 2, 2))
    spec.ilines = [100, 101, 102]
    spec.xlines = list(range(1000, 1000 + traces))
    time = np.arange(samples, dtype=np.float32) * 0.04
    with segyio.create(str(path), spec) as stream:
        index = 0
        for inline in spec.ilines:
            for crossline in spec.xlines:
                stream.header[index] = {
                    189: inline, 21: crossline, 193: crossline, 109: 0, 117: 2000,
                }
                stream.trace[index] = (
                    np.sin(time + crossline * 0.08)
                    + 0.2 * rng.standard_normal(samples)
                ).astype(np.float32)
                index += 1
        stream.bin[segyio.BinField.Interval] = 2000


class Client:
    def __init__(self, base, timeout=180):
        self.base, self.timeout, self.headers = base, timeout, {}

    def request(self, method, path, body=None, response_metadata=None):
        data = None if body is None else json.dumps(body).encode()
        request = Request(self.base + path, data=data, method=method,
                          headers={"Content-Type": "application/json", **self.headers})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                if response_metadata is not None:
                    response_metadata["server_timing_ms"] = {
                        name: float(duration) for name, duration in re.findall(
                            r"([A-Za-z0-9_]+);dur=([0-9.]+)", response.headers.get("Server-Timing", ""))
                    }
                return json.loads(response.read())
        except HTTPError as error:
            raise RuntimeError(f"{method} {path}: {error.code} {error.read().decode()}") from error

    def identity(self, workspace):
        self.headers = {
            "X-SeisCanvas-Project": workspace["project_id"] or "none",
            "X-SeisCanvas-Epoch": workspace["activation_epoch"],
        }
        if workspace["project_id"]:
            self.headers["X-SeisCanvas-Revision"] = str(workspace["revision"])


@contextmanager
def isolated_server(folder, timeout):
    # Reserve a local port for discovery. Uvicorn binds immediately afterwards.
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    environment = {**os.environ, "SEISCANVAS_STATE_DIR": str(folder / "state"),
                   "MPLCONFIGDIR": str(folder / "mpl"), "PYTHONUNBUFFERED": "1"}
    log_path = folder / "server.log"
    with log_path.open("w+") as log:
        process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.main:app", "--host", "127.0.0.1",
             "--port", str(port), "--log-level", "warning"],
            cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT,
        )
        client = Client(f"http://127.0.0.1:{port}", timeout)
        try:
            deadline = perf_counter() + 60
            while True:
                try:
                    client.identity(client.request("GET", "/api/workspace"))
                    break
                except (URLError, TimeoutError):
                    if process.poll() is not None or perf_counter() >= deadline:
                        log.flush()
                        raise RuntimeError("Benchmark server did not start:\n" + log_path.read_text())
                    sleep(0.1)
            yield client
        finally:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


def job_state(client, job_id):
    payload = client.request("GET", "/api/export/jobs")
    jobs = payload["jobs"]
    return next(job for job in jobs if job["id"] == job_id)


def wait_job(client, job_id, timeout):
    deadline = perf_counter() + timeout
    while perf_counter() < deadline:
        job = job_state(client, job_id)
        if job["status"] in TERMINAL:
            if job["status"] != "completed":
                raise RuntimeError(f"Background export did not complete: {job}")
            return job
        sleep(0.025)
    raise TimeoutError(f"Background export {job_id} exceeded {timeout} seconds")


def section_request(client, inline):
    started = perf_counter()
    metadata = {}
    result = client.request("POST", "/api/section", {
        "view_type": "inline", "section_number": inline,
        "target_width": 120, "target_height": 160,
    }, response_metadata=metadata)
    finished = perf_counter()
    if not result.get("z"):
        raise RuntimeError("The section endpoint returned no seismic samples")
    return {"milliseconds": (finished - started) * 1000,
            "started": started, "finished": finished,
            "preview_shape": result["preview_shape"], **metadata}


def measured_sync(client, request, samples, delay):
    started = threading.Event()
    clock = {}
    metadata = {}

    def render():
        clock["start"] = perf_counter()
        started.set()
        try:
            return client.request("POST", "/api/export/queue", request, response_metadata=metadata)
        finally:
            clock["end"] = perf_counter()

    observations = []
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(render)
        started.wait()
        # The sync endpoint has no render-start signal. Preserve this explicit
        # scheduling limitation in the report rather than assuming lock entry.
        sleep(delay)
        for index in range(samples):
            if future.done():
                break
            observed = section_request(client, 101 + index % 2)
            observations.append(observed)
        item = future.result()
    return {
        "export_wall_ms": (clock["end"] - clock["start"]) * 1000,
        "figure_bytes": item["size_bytes"],
        "section_requests": [
            {"milliseconds": observation["milliseconds"],
             "server_timing_ms": observation["server_timing_ms"],
             "started_before_export_response": observation["started"] < clock["end"],
             "finished_before_export_response": observation["finished"] < clock["end"]}
            for observation in observations
        ],
        "phase_timings_ms": metadata.get("server_timing_ms"),
        "start_observation": f"First section sent {delay * 1000:g} ms after dispatch; exact server lock entry is not exposed.",
    }


def measured_background(client, request, samples, timeout):
    started = perf_counter()
    metadata = {}
    submitted = client.request("POST", "/api/export/jobs", request, response_metadata=metadata)
    accepted = perf_counter()
    job_id = submitted["id"]
    deadline = started + timeout
    observed = submitted
    while (observed["status"] not in TERMINAL
           and observed.get("stage") not in {"rendering", "writing"}
           and perf_counter() < deadline):
        sleep(0.01)
        observed = job_state(client, job_id)
    if perf_counter() >= deadline and observed["status"] not in TERMINAL:
        raise TimeoutError("The background export never reached rendering")
    first_status = observed["status"]
    first_stage = observed.get("stage")
    observations = []
    for index in range(samples):
        if observed["status"] in TERMINAL:
            break
        section = section_request(client, 101 + index % 2)
        after = job_state(client, job_id)
        observations.append({"milliseconds": section["milliseconds"],
                             "server_timing_ms": section["server_timing_ms"],
                             "job_status_before": observed["status"],
                             "job_status_after": after["status"],
                             "job_stage_before": observed.get("stage"),
                             "job_stage_after": after.get("stage")})
        observed = after
    final = wait_job(client, job_id, max(1, deadline - perf_counter()))
    finished = perf_counter()
    return {
        "submit_response_ms": (accepted - started) * 1000,
        "submit_server_timing_ms": metadata.get("server_timing_ms"),
        "export_wall_ms": (finished - started) * 1000,
        "section_requests": observations,
        "first_observed_status": first_status,
        "first_observed_stage": first_stage,
        "phase_timings_ms": final.get("timings_ms", final.get("timings")),
        "job_result": final,
        "start_observation": "Sections start after observing the rendering or writing stage; samples retain stage before and after each request.",
    }


def distribution(values):
    return {"count": len(values), "median_ms": statistics.median(values) if values else None,
            "max_ms": max(values) if values else None}


def run(args):
    with tempfile.TemporaryDirectory(prefix="seiscanvas-export-benchmark-") as temporary:
        folder = Path(temporary)
        path = folder / "synthetic.segy"
        synthetic_segy(path, args.samples, args.traces, args.seed)
        file_bytes = path.stat().st_size
        with isolated_server(folder, args.timeout) as client:
            workspace = client.request("POST", "/api/segy/local", {
                "path": str(path), "ilbyte": 189, "xlbyte": 21, "geometry_mode": "auto",
            })
            client.identity(workspace)
            request = {
                "kind": "2d", "dataset": "BackgroundExportBenchmark",
                "state": {"view_type": "inline", "section_number": 100},
                "settings": {"canvas": "fit", "long_edge": args.long_edge,
                             "font": "DejaVu Sans", "format": "png"},
            }
            # Warm both server renderers and each interactive section. Worker
            # process creation is excluded from steady-state comparisons.
            warm = {**request, "settings": {**request["settings"], "long_edge": 600}}
            client.request("POST", "/api/export/queue", warm)
            cold_started = perf_counter()
            cold_job = client.request("POST", "/api/export/jobs", warm)
            cold_result = wait_job(client, cold_job["id"], args.timeout)
            cold_ms = (perf_counter() - cold_started) * 1000
            for inline in (101, 102):
                section_request(client, inline)
            idle = [section_request(client, 101 + index % 2)["milliseconds"]
                    for index in range(args.section_requests)]
            results = {"synchronous": [], "background": []}
            for repeat in range(args.repeats):
                order = ("synchronous", "background") if repeat % 2 == 0 else ("background", "synchronous")
                for mode in order:
                    print(f"Measuring {mode} export {repeat + 1}/{args.repeats}", file=sys.stderr)
                    if mode == "synchronous":
                        measured = measured_sync(client, request, args.section_requests, args.sync_delay)
                    else:
                        measured = measured_background(client, request, args.section_requests, args.timeout)
                    results[mode].append(measured)
                    client.request("DELETE", "/api/export/queue")
    return {
        "benchmark": "Section HTTP latency during synchronous and background 2D export",
        "environment": {"python": platform.python_version(), "platform": platform.platform()},
        "input": {"inlines": 3, "traces_per_inline": args.traces,
                  "samples_per_trace": args.samples, "segy_bytes": file_bytes,
                  "long_edge": args.long_edge, "seed": args.seed,
                  "section_target": [120, 160], "section_cache": "warm"},
        "cold_background_600px_wall_ms": cold_ms,
        "cold_background_phase_timings_ms": cold_result.get("timings_ms", cold_result.get("timings")),
        "idle_section_http": distribution(idle),
        "idle_section_http_ms": idle,
        "concurrent_section_http": {
            mode: distribution([section["milliseconds"] for trial in trials
                                for section in trial["section_requests"]])
            for mode, trials in results.items()
        },
        "concurrent_section_lock_wait": {
            mode: distribution([section["server_timing_ms"]["lock_wait_ms"]
                                for trial in trials for section in trial["section_requests"]
                                if "lock_wait_ms" in section["server_timing_ms"]])
            for mode, trials in results.items()
        },
        "runs": results,
        "scope": [
            "Isolated temporary project, synthetic real SEG-Y, local HTTP, one export at a time.",
            "Server-Timing exposes cumulative project-lock wait/hold time and any available export phases. The synchronous endpoint has no render-start event; overlap uses client dispatch and completion times.",
            "Background timings are emitted by the server without relabelling; source loading may include geometry-cache reads, while amplitude reads can occur during rendering.",
            "The first 600 px background job reports cold startup separately; subsequent rendering and both section caches are warmed.",
            "Rendering stage brackets section requests, but its scope includes amplitude reads and staging; it is not exclusively Matplotlib drawing.",
            "No browser drawing, large-survey memory result, timing threshold, or general speedup guarantee is implied.",
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=1024)
    parser.add_argument("--traces", type=int, default=256)
    parser.add_argument("--long-edge", type=int, default=3000)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--section-requests", type=int, default=5)
    parser.add_argument("--sync-delay", type=float, default=0.05)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", type=Path, default=ROOT / "output/background-export-qa/benchmark.json")
    args = parser.parse_args()
    if args.samples < 8 or args.traces < 8 or args.repeats < 1 or args.section_requests < 1:
        parser.error("samples/traces must be at least 8; repeats and section-requests must be positive")
    if not 600 <= args.long_edge <= 4000 or args.sync_delay < 0 or args.timeout <= 0:
        parser.error("long-edge must be 600–4000, sync-delay non-negative, and timeout positive")
    result = run(args)
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(encoded, encoding="utf-8")
    print(encoded, end="")


if __name__ == "__main__":
    main()
