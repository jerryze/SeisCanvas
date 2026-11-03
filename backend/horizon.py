"""Horizon picks: text parsing, column mapping, persistent cache and previews."""

from pathlib import Path
import codecs
import csv
import re
import numpy as np
from backend.horizon_cache import cache_path, load_cached, save_cached

_BINARY_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

def _is_number(value):
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False


def _text_rows(path):
    """Stream text records independently of the filename or MIME type."""
    with open(path, "rb") as source:
        sample = source.read(65536)
    encoding = None
    for bom, name in ((codecs.BOM_UTF32_LE, "utf-32"), (codecs.BOM_UTF32_BE, "utf-32"),
                      (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
        if sample.startswith(bom):
            encoding = name
            break
    if encoding is None:
        for name in ("utf-8-sig", "gb18030"):
            try:
                codecs.getincrementaldecoder(name)().decode(sample, final=False)
                encoding = name
                break
            except UnicodeError:
                pass
    if encoding is None:
        raise ValueError(f"{Path(path).name}: 无法识别文本编码，请转换为 UTF-8。")
    try:
        with open(path, encoding=encoding) as source:
            for number, line in enumerate(source, 1):
                if _BINARY_CONTROLS.search(line):
                    raise ValueError(f"{Path(path).name}: 文件包含二进制内容，需要层位文本数据。")
                text = line.strip()
                if not text:
                    continue
                comment = text.startswith("#")
                if comment:
                    text = text[1:].strip()
                # Ignore separators inside quoted fields; preserve empty CSV
                # cells so column mapping can never silently shift positions.
                unquoted = re.sub(r'"(?:[^"]|"")*"', '', text)
                delimiter = max(",;\t|", key=unquoted.count)
                tokens = next(csv.reader([text], delimiter=delimiter, skipinitialspace=True)) \
                    if unquoted.count(delimiter) else text.split()
                if tokens:
                    yield number, [token.strip() for token in tokens], comment
    except UnicodeError as error:
        raise ValueError(f"{Path(path).name}: 文本编码无效，请转换为 UTF-8。") from error
    except csv.Error as error:
        raise ValueError(f"{Path(path).name}: 无法解析文本数据列：{error}") from error


def horizon_preview(path, sample_size=8):
    """Read a small, string-preserving preview for manual column mapping."""
    header = []
    rows = []
    for _, tokens, comment in _text_rows(path):
        if comment:
            if not header:
                header = tokens
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
        self.path = Path(path).resolve()
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
        for line_number, tokens, comment in _text_rows(path):
            if comment:
                continue
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
