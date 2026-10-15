"""Package the browser's exact WebGL rendering without changing the camera.

The request schema (``SceneExportRequest``) lives in ``backend.models``.
"""

import base64
import binascii
import io
from html import escape
import struct
import zlib
import numpy as np
from PIL import Image, UnidentifiedImageError
from matplotlib.figure import Figure
from matplotlib.path import Path as VectorPath
from matplotlib.patches import PathPatch
from backend.models import MAX_SCENE_PIXELS


def decode_scene_png(req):
    """Validate the browser's WebGL PNG and return raw bytes, RGBA pixels and size.

    Plotly rasterises the layout at ``scale``, so the exact canvas size may differ
    from the requested product by a pixel; anything larger is rejected.
    """
    prefix = "data:image/png;base64,"
    if not req.png.startswith(prefix):
        raise ValueError("Expected a PNG rendering.")
    expected = (req.width * req.scale, req.height * req.scale)
    try:
        raw = base64.b64decode(req.png[len(prefix) :], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise ValueError("Expected a PNG rendering.")
            if any(abs(size - want) > 2 for size, want in zip(image.size, expected)):
                raise ValueError("PNG dimensions do not match the export settings.")
            size = image.size
            if req.format == "pdf":
                pixels = np.asarray(image.convert("RGBA"))
            else:
                # PNG/SVG use the renderer's encoded stream directly. Verify
                # chunk checksums without decoding millions of RGBA pixels.
                image.verify()
                pixels = None
    except (binascii.Error, UnidentifiedImageError, OSError) as e:
        raise ValueError("Invalid PNG rendering.") from e
    return raw, pixels, size


def _path_groups(overlay, layer):
    """One compound fill per native colour, preserving shared triangle edges."""
    groups = {}
    if overlay is not None:
        for path in overlay.paths:
            if path.layer == layer and path.opacity > 0:
                groups.setdefault((path.color, path.opacity), []).append(path.points)
    return groups


def _svg_vectors(overlay, layer):
    number = lambda value: f"{float(value):.9g}"
    parts = []
    for (color, opacity), paths in _path_groups(overlay, layer).items():
        commands = []
        for points in paths:
            commands.append("M" + " L".join(f"{number(x)} {number(y)}" for x, y in points) + " Z")
        parts.append(f'<path d="{" ".join(commands)}" fill="{color}" fill-opacity="{number(opacity)}"/>')
    if overlay is not None:
        for line in overlay.lines:
            if line.layer == layer and line.opacity > 0:
                points = " ".join(f"{number(x)},{number(y)}" for x, y in line.points)
                parts.append(f'<polyline points="{points}" fill="none" stroke="{line.color}" stroke-width="{number(line.width)}" stroke-opacity="{number(line.opacity)}"/>')
    return "".join(parts)


def _pdf_vectors(ax, overlay, layer, dpi):
    order = -1 if layer == "back" else 1
    for (color, opacity), paths in _path_groups(overlay, layer).items():
        vertices, codes = [], []
        for points in paths:
            vertices.extend([*points, points[0]])
            codes.extend([VectorPath.MOVETO, *([VectorPath.LINETO] * (len(points) - 1)), VectorPath.CLOSEPOLY])
        ax.add_patch(PathPatch(VectorPath(vertices, codes), facecolor=color,
                              edgecolor="none", linewidth=0, alpha=opacity,
                              antialiased=True, rasterized=False, zorder=order))
    if overlay is not None:
        for line in overlay.lines:
            if line.layer == layer and line.opacity > 0:
                points = np.asarray(line.points)
                ax.plot(points[:, 0], points[:, 1], color=line.color,
                        linewidth=line.width * 72 / dpi, alpha=line.opacity,
                        antialiased=True, rasterized=False, zorder=order)


def encode_scene(req, raw, pixels, size):
    if req.format == "png":
        if req.dpi is not None:
            # Insert pHYs metadata without decompressing/recompressing IDAT.
            ppm = round(req.dpi / 0.0254)
            chunk = b"pHYs" + struct.pack(">IIB", ppm, ppm, 1)
            phys = struct.pack(">I", 9) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xffffffff)
            parts = [raw[:8]]
            offset = 8
            while offset < len(raw):
                length = struct.unpack(">I", raw[offset:offset + 4])[0]
                end = offset + length + 12
                kind = raw[offset + 4:offset + 8]
                if kind != b"pHYs":
                    parts.append(raw[offset:end])
                if kind == b"IHDR":
                    parts.append(phys)
                offset = end
            return b"".join(parts)
        return raw
    if req.format == "svg":
        # Actors retain the exact WebGL rendering; coordinate furniture is
        # native vector geometry, projected/cropped by that same renderer.
        payload = base64.b64encode(raw).decode("ascii")
        width, height = size
        svg_width = f"{width / req.dpi * 72}pt" if req.dpi else f"{width}px"
        svg_height = f"{height / req.dpi * 72}pt" if req.dpi else f"{height}px"
        background = ("" if req.background == "transparent" else
                      f'<rect width="{width}" height="{height}" fill="{req.background}"/>')
        labels = " ".join(req.vector_overlay.labels) if req.vector_overlay else ""
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{svg_width}" height="{svg_height}" viewBox="0 0 {width} {height}">'
            f'<title>SeisCanvas 3D scene</title><desc>{escape(labels)}</desc>{background}'
            f'<g id="axes-back">{_svg_vectors(req.vector_overlay, "back")}</g>'
            f'<image width="{width}" height="{height}" xlink:href="data:image/png;base64,{payload}"/>'
            f'<g id="axes-front">{_svg_vectors(req.vector_overlay, "front")}</g></svg>'
        ).encode()
    dpi = req.dpi or 96 * req.scale
    width, height = size
    fig = Figure(figsize=(width / dpi, height / dpi), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_axis_off()
    ax.set_facecolor("none")
    ax.set_xlim(0, width)
    ax.set_ylim(height, 0)
    _pdf_vectors(ax, req.vector_overlay, "back", dpi)
    ax.imshow(pixels, origin="upper", extent=(0, width, height, 0),
              aspect="auto", interpolation="none", zorder=0)
    _pdf_vectors(ax, req.vector_overlay, "front", dpi)
    output = io.BytesIO()
    transparent = req.background == "transparent"
    fig.savefig(output, format="pdf", dpi=dpi, facecolor="none" if transparent else req.background,
                transparent=transparent, pad_inches=0,
                metadata={"Title": "SeisCanvas 3D scene",
                          "Subject": "Native vector coordinate outlines over the WebGL scene"})
    return output.getvalue()


def package_scene(req):
    if req.width * req.height * req.scale**2 > MAX_SCENE_PIXELS:
        raise ValueError("Export exceeds 24 megapixels.")
    raw, pixels, size = decode_scene_png(req)
    return encode_scene(req, raw, pixels, size)
