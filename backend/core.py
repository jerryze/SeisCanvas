from collections import OrderedDict
from pathlib import Path
from threading import RLock
import io
import numpy as np
import segyio
from backend.regular_geometry import RegularGeometry, probe_regular
from backend.geometry import cache_key, load_geometry, save_geometry, build_geometry
import matplotlib

matplotlib.use("Agg")
from matplotlib.figure import Figure
from matplotlib import colormaps
from matplotlib.colors import LinearSegmentedColormap

# A muted diverging ramp matching the supplied Pos / 0 / Neg reference:
# positive amplitudes are red, zero is near-white, and negative amplitudes are blue.
CUSTOM_CMAPS = {
    "red_white_blue": LinearSegmentedColormap.from_list(
        "red_white_blue",
        [
            (0.00, "#2f3798"),
            (0.10, "#454a9e"),
            (0.20, "#6a74af"),
            (0.30, "#8fa1c2"),
            (0.40, "#b9d0d5"),
            (0.50, "#fffafa"),
            (0.60, "#f6d7d4"),
            (0.70, "#dc9e9e"),
            (0.80, "#c06b69"),
            (0.90, "#a63335"),
            (1.00, "#800000"),
        ],
    )
}
CMAPS = [
    "gray",
    "Greys",
    "binary",
    "seismic",
    "red_white_blue",
    "RdBu",
    "coolwarm",
    "viridis",
    "turbo",
]
LOCK = RLock()


def get_cmap(name, reverse=False):
    """Return a built-in or application-defined colormap."""
    cmap = CUSTOM_CMAPS.get(name)
    if cmap is None:
        cmap = colormaps[name]
    return cmap.reversed() if reverse else cmap


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


def _is_number(value):
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def horizon_preview(path, sample_size=8):
    """Read a small, string-preserving preview for manual column mapping."""
    header = []
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            text = line.strip()
            if not text:
                continue
            if text.startswith("#"):
                candidate = text[1:].strip().split()
                if candidate and not header:
                    header = candidate
                continue
            tokens = text.split()
            if not tokens:
                continue
            # A non-comment header such as "inline xline time" is allowed too.
            if not any(_is_number(token) for token in tokens):
                if not header:
                    header = tokens
                continue
            rows.append(tokens)
            if len(rows) >= sample_size:
                break
    if not rows:
        raise ValueError("Horizon file has no data rows.")

    count = max(len(row) for row in rows)
    names = header[:count]
    names += [f"Column {i + 1}" for i in range(len(names), count)]

    def suggest(aliases, default):
        lowered = [name.lower() for name in names]
        for alias in aliases:
            if alias in lowered:
                return lowered.index(alias)
        for alias in aliases:
            for index, name in enumerate(lowered):
                if alias in name:
                    return index
        return min(default, count - 1)

    return {
        "columns": [
            {"index": index, "name": name}
            for index, name in enumerate(names)
        ],
        "rows": [row + [""] * (count - len(row)) for row in rows],
        "suggestions": {
            "inline": suggest(["inline", "iline", "line"], 0),
            "xline": suggest(["xline", "crossline", "trace", "xl"], 1),
            "time": suggest(["time", "twt", "depth", "z"], 2),
        },
    }


class Horizon:
    def __init__(self, path, name=None, columns=(0, 1, 2)):
        self.name = name or Path(path).stem
        try:
            columns = tuple(int(column) for column in columns)
        except (TypeError, ValueError) as e:
            raise ValueError(
                f"{self.name}: column selections must be non-negative integers."
            ) from e
        if len(columns) != 3 or len(set(columns)) != 3 or min(columns) < 0:
            raise ValueError(
                f"{self.name}: Inline, Xline and Time must use three different non-negative columns."
            )
        self.columns = columns

        from backend.horizon_cache import cache_path, load_cached
        cached_path = cache_path(path, columns)
        cached = load_cached(cached_path)
        self.cache_hit = cached is not None
        if cached is not None:
            self.data = cached
            return
        from array import array
        rows = array("d")
        data_started = False
        maximum = max(columns)
        with open(path, encoding="utf-8-sig") as f:
            for line_number, line in enumerate(f, 1):
                text = line.strip()
                if not text or text.startswith("#"):
                    continue
                tokens = text.split()
                if maximum >= len(tokens):
                    if data_started:
                        raise ValueError(
                            f"{self.name}: incomplete data row at line {line_number}."
                        )
                    continue
                try:
                    rows.extend([float(tokens[column]) for column in columns])
                except ValueError as e:
                    if data_started:
                        raise ValueError(
                            f"{self.name}: selected columns must be numeric at line {line_number}."
                        ) from e
                    # Ignore a textual header before the first numeric row.
                    continue
                data_started = True

        if not rows:
            raise ValueError(f"{self.name}: empty horizon or invalid column mapping.")
        data = np.asarray(rows, dtype=float).reshape(-1, 3)
        valid = np.isfinite(data).all(axis=1) & (
            data[:, :2] == np.floor(data[:, :2])
        ).all(axis=1)
        if not valid.all():
            raise ValueError(
                f"{self.name}: invalid coordinates at data row {int(np.flatnonzero(~valid)[0])+1}."
            )
        self.data = data
        from backend.horizon_cache import save_cached
        save_cached(cached_path, data)

    def section(self, mode, number):
        axis = 0 if mode == "inline" else 1
        points = self.data[self.data[:, axis] == number][:, [1 - axis, 2]]
        return points[np.argsort(points[:, 0])].tolist()


def amplitude(z, s):
    z = -z if s.reverse_polarity else z
    if s.clip_mode == "manual":
        if s.vmin is None or s.vmax is None or s.vmin >= s.vmax:
            raise ValueError("Manual amplitude minimum must be less than maximum.")
        lo, hi = s.vmin, s.vmax
    elif s.symmetric:
        hi = float(np.percentile(np.abs(z), s.clip_percentile)) or 1.0
        lo = -hi
    else:
        tail = (100 - s.clip_percentile) / 2
        lo, hi = np.percentile(z, [tail, 100 - tail]).tolist()
        if hi == lo:
            lo, hi = lo - 1, hi + 1
    return z, lo, hi


def render(survey, horizons, state, settings):
    x, t, z = survey.section(state.view_type, state.section_number)
    z, lo, hi = amplitude(z, state.seismic)
    fig = Figure(
        figsize=(settings.width / 25.4, settings.height / 25.4),
        dpi=settings.dpi,
        layout="constrained",
    )
    ax = fig.subplots()
    if state.aspect_ratio_2d is not None:
        horizontal, vertical = state.aspect_ratio_2d
        ax.set_box_aspect(vertical / horizontal)
    cmap = get_cmap(state.seismic.colormap, state.seismic.reverse_colormap)
    ax.pcolormesh(
        x, t, z, cmap=cmap, vmin=lo, vmax=hi, shading="nearest", rasterized=True
    )
    dash = {"solid": "-", "dashed": "--", "dotted": ":", "dashdot": "-."}
    markers = {
        "circle": "o",
        "square": "s",
        "triangle": "^",
        "diamond": "D",
        "cross": "x",
        "plus": "+",
    }
    for h in state.horizons:
        if not h.visible or h.id not in horizons:
            continue
        pts = np.asarray(horizons[h.id].section(state.view_type, state.section_number))
        if not len(pts):
            continue
        if h.line.visible and h.line.style != "none":
            if h.outline.enabled:
                ax.plot(
                    pts[:, 0],
                    pts[:, 1],
                    color="black",
                    lw=h.line.width + 2 * h.outline.width,
                    ls=dash[h.line.style],
                )
            ax.plot(
                pts[:, 0],
                pts[:, 1],
                color=h.color,
                lw=h.line.width,
                ls=dash[h.line.style],
            )
        if h.marker.visible and h.marker.shape != "none":
            ax.plot(
                pts[:, 0],
                pts[:, 1],
                ls="none",
                marker=markers[h.marker.shape],
                ms=h.marker.size,
                color=h.color,
                markeredgecolor="black" if h.outline.enabled else h.color,
                markeredgewidth=h.outline.width if h.outline.enabled else 0,
            )
    ax.set_xlim(state.x_range or [float(x[0]) - 0.5, float(x[-1]) + 0.5])
    tr = state.time_range or [float(t[0]), float(t[-1])]
    ax.set_ylim(max(tr), min(tr))
    if not settings.show_axes:
        ax.set_axis_off()
    if settings.show_axes and settings.show_labels:
        ax.set_xlabel("Crossline" if state.view_type == "inline" else "Inline")
        ax.set_ylabel("TWT (ms)")
    if settings.show_title:
        ax.set_title(f"{state.view_type.title()} {state.section_number}")
    for txt in [
        ax.title,
        ax.xaxis.label,
        ax.yaxis.label,
        *ax.get_xticklabels(),
        *ax.get_yticklabels(),
    ]:
        txt.set_fontfamily(settings.font)
        txt.set_fontsize(settings.font_size)
    out = io.BytesIO()
    fig.savefig(out, format=settings.format, dpi=settings.dpi)
    return out.getvalue()
