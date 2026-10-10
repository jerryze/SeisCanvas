"""Self-describing scientific file names for exported figures.

A name follows ``Dataset + View + Location/Target + Content + Key Style + Size
+ DPI``.  Only parameters that make a figure recognisable at a glance belong in
the name; the complete reproduction parameters live in export_manifest.json.
"""

from __future__ import annotations

import re

# Long enough for a fully qualified name, short enough for every file system.
MAX_STEM = 150

ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

#: Colormaps render in their canonical scientific spelling.
COLORMAP_LABELS = {
    "seismic": "Seismic",
    "red_white_blue": "RedWhiteBlue",
    "RdBu": "RdBu",
    "coolwarm": "Coolwarm",
    "viridis": "Viridis",
    "turbo": "Turbo",
    "gray": "Gray",
    "Greys": "Greys",
    "binary": "Binary",
    "petrel": "Petrel",
    "cividis": "Cividis",
    "jet": "Jet",
}

DISPLAY_LABELS = {
    "filled": "Filled",
    "contour": "Contour",
    "filled_contour": "FilledContour",
    "signed_difference": "SignedDifference",
    "absolute_error": "AbsoluteError",
}

#: ZIP directory of every supported view type (requirement: automatic grouping).
ZIP_FOLDERS = {
    "2d_inline": "2D/Inline",
    "2d_crossline": "2D/Crossline",
    "3d_multislice": "3D",
    "3d_horizon_surface": "3D",
    "horizon_map": "HorizonMap",
    "horizon_profile": "HorizonProfile",
}


def sanitize(text, fallback="Untitled"):
    """Remove illegal characters, unify spaces and collapse repeated separators."""
    value = ILLEGAL.sub("-", str(text if text is not None else ""))
    value = re.sub(r"\s+", "-", value.strip())
    value = re.sub(r"-{2,}", "-", value)
    value = re.sub(r"_{2,}", "_", value)
    value = value.strip("-_.")
    return value or fallback


def extension(value, fallback="png"):
    clean = re.sub(r"[^0-9a-z]", "", str(value or "").lower())
    return clean or fallback


def colormap_label(name, fallback="Colormap"):
    if not name:
        return None
    return COLORMAP_LABELS.get(str(name)) or sanitize(name, fallback)


def display_label(value, fallback="Filled"):
    if not value:
        return fallback
    return DISPLAY_LABELS.get(str(value)) or sanitize(value, fallback).title().replace("-", "")


def number(value):
    """Format a number without a trailing ``.0`` (180 -> ``180``)."""
    if isinstance(value, str):
        return sanitize(value, "0")
    if isinstance(value, bool) or value is None:
        return "0"
    if float(value).is_integer():
        return str(int(value))
    return f"{float(value):g}"


def size_segment(width_mm, height_mm, dpi):
    return f"{number(width_mm)}x{number(height_mm)}mm_{number(dpi)}dpi"


def horizons_label(names):
    """``H1-H2`` for a few horizons, ``Horizons6`` for a long collection."""
    cleaned = []
    for name in names:
        value = sanitize(name, "H")
        if value and value not in cleaned:
            cleaned.append(value)
    if not cleaned:
        return None
    if len(cleaned) <= 3:
        return "-".join(cleaned)
    return f"Horizons{len(cleaned)}"


def comparison_label(comparison, reference):
    """Ordered pair: the difference is comparison minus reference."""
    return f"{sanitize(comparison, 'Comparison')}-vs-{sanitize(reference, 'Reference')}"


def _range(values, prefix, pad=0, suffix=""):
    points = sorted({float(v) for v in values})
    if not points:
        return None

    def value(point):
        if pad:
            return f"{int(round(point)):0{pad}d}"
        return number(point)

    if len(points) == 1:
        return f"{prefix}{value(points[0])}{suffix}"
    return f"{prefix}{value(points[0])}-{value(points[-1])}{suffix}"


def slice_label(inlines=(), crosslines=(), times=()):
    """``IL0350-0450_XL0600-0800_TWT1200ms`` for a multi-slice scene."""
    parts = [
        _range(inlines, "IL", pad=4),
        _range(crosslines, "XL", pad=4),
        _range(times, "TWT", suffix="ms"),
    ]
    return "_".join(part for part in parts if part) or None


def _assemble(head, optional, tail, ext):
    """Join segments, dropping optional style segments when the name is too long."""
    head = [str(p) for p in head if p not in (None, "")]
    optional = [str(p) for p in optional if p not in (None, "")]
    tail = [str(p) for p in tail if p not in (None, "")]

    def join(parts):
        stem = "_".join(parts)
        return re.sub(r"_{2,}", "_", stem).strip("_")

    stem = join([*head, *optional, *tail])
    while optional and len(stem) > MAX_STEM:
        optional.pop()
        stem = join([*head, *optional, *tail])
    if len(stem) > MAX_STEM:
        overflow = len(stem) - MAX_STEM
        if len(head[0]) > overflow + 4:
            head[0] = head[0][: len(head[0]) - overflow].strip("-_.")
            stem = join([*head, *optional, *tail])
        else:  # pragma: no cover - defensive, requires an extreme dataset name
            stem = stem[:MAX_STEM].strip("-_.")
    return f"{stem}.{extension(ext)}"


def dataset_label(value, fallback="Dataset"):
    return sanitize(value, fallback)


def inline_name(dataset, inline, content, colormap, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "2D", "Inline", f"IL{int(round(inline)):04d}"],
        [content, colormap],
        [size_segment(width, height, dpi)],
        ext,
    )


def crossline_name(dataset, crossline, content, colormap, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "2D", "Crossline", f"XL{int(round(crossline)):04d}"],
        [content, colormap],
        [size_segment(width, height, dpi)],
        ext,
    )


def multislice_name(dataset, slices, content, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "3D", "MultiSlice", slices],
        [content],
        [size_segment(width, height, dpi)],
        ext,
    )


def horizon_surface_name(dataset, content, scalar, colormap, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "3D", "HorizonSurface", content, scalar],
        [colormap],
        [size_segment(width, height, dpi)],
        ext,
    )


def horizon_map_name(
    dataset, horizon, scalar, display, colormap, width, height, dpi, ext="png",
    *, difference_type=None,
):
    # ``Amplitude`` maps carry no display segment, a contour-only map is not
    # filled (so the colormap adds nothing). Difference type and rendering
    # display are separate: signed/absolute must not replace filled/contour.
    segments = [] if str(scalar) == "Amplitude" else [display]
    if difference_type is not None:
        difference = {"signed": "SignedDifference", "absolute": "AbsoluteError"}[difference_type]
        segments.insert(0, difference)
    optional = [] if str(display) == "Contour" else [colormap]
    return _assemble(
        [dataset, "HorizonMap", sanitize(horizon, "Horizon"), scalar, *segments],
        optional,
        [size_segment(width, height, dpi)],
        ext,
    )


def map_profile_name(dataset, horizon, scalar, colormap, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "HorizonMap", horizon, scalar, "ProfileAB"],
        [colormap],
        [size_segment(width, height, dpi)],
        ext,
    )


def horizon_profile_name(dataset, horizon, location, scalar, width, height, dpi, ext="png"):
    return _assemble(
        [dataset, "HorizonProfile", horizon, location, scalar],
        [],
        [size_segment(width, height, dpi)],
        ext,
    )


def zip_folder(view_type):
    """Directory inside the archive for a view type (empty means archive root)."""
    return ZIP_FOLDERS.get(view_type, "")


def unique_name(filename, taken):
    """Append ``_02``, ``_03`` … when a name is already used in the session."""
    used = {name.lower() for name in taken}
    if filename.lower() not in used:
        return filename
    stem, dot, ext = str(filename).rpartition(".")
    if not dot:
        stem, ext = str(filename), ""
    counter = 2
    while True:
        candidate = f"{stem}_{counter:02d}.{ext}" if ext else f"{stem}_{counter:02d}"
        if candidate.lower() not in used:
            return candidate
        counter += 1
