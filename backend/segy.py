"""SEG-Y data access: trace indexing, geometry caches and section reads."""

from collections import OrderedDict
from pathlib import Path
from threading import RLock
import numpy as np
import segyio
from backend.geometry import cache_key, load_geometry, save_geometry, build_geometry
from backend.regular_geometry import RegularGeometry, probe_regular

LOCK = RLock()


class ArrayCache(OrderedDict):
    """Bound retained array memory as well as entry count (shared by 2D/3D)."""
    def __init__(self, max_bytes=256 * 1024 * 1024):
        super().__init__()
        self.max_bytes = max_bytes

    @staticmethod
    def size(value):
        if isinstance(value, np.ndarray):
            return value.nbytes
        if isinstance(value, (tuple, list)):
            return sum(ArrayCache.size(v) for v in value)
        return 0

    def __setitem__(self, key, value):
        if key in self:
            del self[key]
        size = self.size(value)
        if size > self.max_bytes:
            return
        while self and (len(self) >= 12 or sum(self.size(v) for v in self.values()) + size > self.max_bytes):
            self.popitem(last=False)
        super().__setitem__(key, value)


class Survey:
    def __init__(self, path, ilbyte=189, xlbyte=21, progress=None, geometry_mode="auto"):
        report = progress or (lambda percent, stage: None)
        report(2, "打开 SEG-Y")
        self.path = Path(path)
        self.cache = ArrayCache()
        # Rendering-layer resampling results; kept apart from the native cache.
        self.render_cache = ArrayCache(max_bytes=96 * 1024 * 1024)
        self.regular = None
        if geometry_mode == "regular":
            key = cache_key(self.path, ilbyte, xlbyte, "regular-formula-v1")
            saved = load_geometry(key)
            self.geometry_cached = saved is not None
            self.regular = RegularGeometry(saved) if saved is not None else probe_regular(self.path, ilbyte, xlbyte, report)
            self.geometry_cache_saved = True if saved is not None else save_geometry(key, self.regular.parameters())
            g = self.regular
            self.times = g.delay + np.arange(g.ns, dtype=float) * g.dt / 1000
            self.count, self.interval, self.sample_format = g.count, g.dt / 1000, g.format
            self.inlines, self.crosslines = g.inlines, g.crosslines
            self.trace_lookup = None
            report(98, "已加载公式几何缓存" if saved is not None else "公式几何完成，准备显示")
            return
        key = cache_key(self.path, ilbyte, xlbyte, geometry_mode)
        report(3, "读取文件采样信息")
        with segyio.open(str(path), ignore_geometry=True) as f:
            # segyio reads binary metadata and the first trace's time origin only.
            # No amplitudes, per-trace time validation or geometry inference.
            self.times = np.asarray(f.samples, dtype=float)
            self.count = f.tracecount
            self.interval = float(segyio.tools.dt(f)) / 1000
            self.sample_format = int(f.format)
            report(4, "查找几何缓存")
            arrays = load_geometry(key)
            required = {"ils", "xls", "inlines", "crosslines", "inline_order", "inline_starts", "crossline_order", "crossline_starts"}
            self.geometry_cached = arrays is not None and required.issubset(arrays)
            if not self.geometry_cached:
                arrays = build_geometry(f, ilbyte, xlbyte, report)
                report(95, "保存几何缓存")
                self.geometry_cache_saved = save_geometry(key, arrays)
            else:
                report(95, "已加载几何缓存，跳过道头扫描")
                self.geometry_cache_saved = True
        self.ils, self.xls = arrays["ils"], arrays["xls"]
        self.inlines, self.crosslines = arrays["inlines"], arrays["crosslines"]
        self.trace_lookup = arrays.get("lookup")
        self.maps = {}
        self.axis_positions = {}
        for mode, axis in [("inline", self.inlines), ("crossline", self.crosslines)]:
            order, starts = arrays[f"{mode}_order"], arrays[f"{mode}_starts"]
            self.maps[mode] = dict(zip(axis.tolist(), np.split(order, starts[1:])))
            self.axis_positions[mode] = {int(value): i for i, value in enumerate(axis)}

        report(98, "索引完成，准备显示")

    def metadata(self):
        return dict(
            filename=self.path.name,
            inlines=self.inlines.tolist(),
            crosslines=self.crosslines.tolist(),
            samples=len(self.times),
            sample_interval=self.interval,
            time_range=[float(self.times[0]), float(self.times[-1])],
            traces=self.count,
            sample_format=self.sample_format,
            geometry_cached=self.geometry_cached,
            geometry_cache_saved=self.geometry_cache_saved,
        )

    def section(self, mode, number):
        if mode not in ("inline", "crossline") or (self.regular is None and number not in self.maps[mode]):
            raise ValueError("Section does not exist in this survey.")
        key = (mode, number)
        with LOCK:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            if self.regular is not None:
                section_coords, ids = self.regular.section_ids(mode, number)
            else:
                coords = self.xls if mode == "inline" else self.ils
                if self.trace_lookup is not None:
                    position = self.axis_positions[mode][number]
                    ids = self.trace_lookup[position, :] if mode == "inline" else self.trace_lookup[:, position]
                    ids = ids[ids >= 0]
                else:
                    ids = self.maps[mode][number]
                    ids = ids[np.argsort(coords[ids])]
                section_coords = coords[ids]
            with segyio.open(str(self.path), ignore_geometry=True) as f:
                # Allocate once; a list of all traces plus stack doubles peak memory.
                z = np.empty((len(self.times), len(ids)), dtype=np.float32)
                for col, trace in enumerate(ids):
                    z[:, col] = f.trace[int(trace)]
            if not np.isfinite(z).all():
                np.nan_to_num(z, copy=False)
            result = (section_coords, self.times, z)
            self.cache[key] = result
            while len(self.cache) > 12:
                self.cache.popitem(last=False)
            return result
