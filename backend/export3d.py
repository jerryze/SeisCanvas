"""Package the browser's exact WebGL rendering without changing the camera.

The request schema (``SceneExportRequest``) lives in ``backend.models``.
"""

import base64
import binascii
import io
import struct
import zlib
import numpy as np
from PIL import Image, UnidentifiedImageError
from matplotlib.figure import Figure
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
        # WebGL content is an embedded high-resolution image, not vector geometry.
        payload = base64.b64encode(raw).decode("ascii")
        width, height = size
        svg_width = f"{width / req.dpi * 72}pt" if req.dpi else f"{width}px"
        svg_height = f"{height / req.dpi * 72}pt" if req.dpi else f"{height}px"
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{svg_width}" height="{svg_height}" viewBox="0 0 {width} {height}">'
            f'<title>SeisCanvas 3D scene</title><image width="{width}" height="{height}" xlink:href="data:image/png;base64,{payload}"/></svg>'
        ).encode()
    dpi = req.dpi or 96 * req.scale
    width, height = size
    fig = Figure(figsize=(width / dpi, height / dpi), dpi=dpi)
    fig.figimage(pixels, origin="upper")
    output = io.BytesIO()
    fig.savefig(output, format="pdf", dpi=dpi, facecolor="white", pad_inches=0)
    return output.getvalue()


def package_scene(req):
    if req.width * req.height * req.scale**2 > MAX_SCENE_PIXELS:
        raise ValueError("Export exceeds 24 megapixels.")
    raw, pixels, size = decode_scene_png(req)
    return encode_scene(req, raw, pixels, size)
