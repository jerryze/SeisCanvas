"""Horizon picks: text parsing, column mapping, persistent cache and previews."""

from pathlib import Path
import numpy as np
from backend.horizon_cache import cache_path, load_cached, save_cached


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
        save_cached(cached_path, data)

    def section(self, mode, number):
        axis = 0 if mode == "inline" else 1
        points = self.data[self.data[:, axis] == number][:, [1 - axis, 2]]
        return points[np.argsort(points[:, 0])].tolist()
