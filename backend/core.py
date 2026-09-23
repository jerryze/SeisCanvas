from collections import OrderedDict
from pathlib import Path
from threading import RLock
import io
import numpy as np
import segyio
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


class Survey:
    def __init__(self, path, ilbyte=189, xlbyte=21):
        self.path = Path(path)
        self.cache = OrderedDict()
        with segyio.open(str(path), ignore_geometry=True) as f:
            self.ils = np.asarray(f.attributes(ilbyte)[:], dtype=np.int64)
            self.xls = np.asarray(f.attributes(xlbyte)[:], dtype=np.int64)
            self.times = np.asarray(f.samples, dtype=float)
            self.count = f.tracecount
            self.interval = float(segyio.tools.dt(f)) / 1000
            delays = np.unique(f.attributes(109)[:])
            intervals = np.unique(f.attributes(117)[:])
            if len(delays) > 1 or len(intervals) > 1:
                raise ValueError(
                    "Traces have different start times or sample intervals; resample to a common time axis first."
                )
            if len(self.times) < 2 or not np.all(np.diff(self.times) > 0):
                raise ValueError(
                    "SEG-Y must have at least two increasing time samples."
                )
        pairs = np.rec.fromarrays([self.ils, self.xls])
        if np.unique(pairs).size != self.count:
            raise ValueError(
                "Header bytes produce duplicate Inline/Crossline pairs. Please check the geometry bytes."
            )
        self.inlines = np.unique(self.ils)
        self.crosslines = np.unique(self.xls)
        self.maps = {}
        for mode, values in [("inline", self.ils), ("crossline", self.xls)]:
            order = np.argsort(values, kind="stable")
            keys, starts = np.unique(values[order], return_index=True)
            self.maps[mode] = dict(zip(keys.tolist(), np.split(order, starts[1:])))

    def metadata(self):
        return dict(
            filename=self.path.name,
            inlines=self.inlines.tolist(),
            crosslines=self.crosslines.tolist(),
            samples=len(self.times),
            sample_interval=self.interval,
            time_range=[float(self.times[0]), float(self.times[-1])],
            traces=self.count,
        )

    def section(self, mode, number):
        if mode not in self.maps or number not in self.maps[mode]:
            raise ValueError("Section does not exist in this survey.")
        key = (mode, number)
        with LOCK:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            ids = self.maps[mode][number]
            coords = self.xls if mode == "inline" else self.ils
            ids = ids[np.argsort(coords[ids])]
            with segyio.open(str(self.path), ignore_geometry=True) as f:
                z = np.stack([f.trace[int(i)] for i in ids], axis=1)
            if not np.isfinite(z).all():
                z = np.nan_to_num(z)
            result = (coords[ids], self.times, z)
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

        rows = []
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
                    rows.append([float(tokens[column]) for column in columns])
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
        data = np.asarray(rows, dtype=float)
        valid = np.isfinite(data).all(axis=1) & (
            data[:, :2] == np.floor(data[:, :2])
        ).all(axis=1)
        if not valid.all():
            raise ValueError(
                f"{self.name}: invalid coordinates at data row {int(np.flatnonzero(~valid)[0])+1}."
            )
        self.data = data

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
    if settings.show_labels:
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
