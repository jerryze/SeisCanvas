"""Package the browser's exact WebGL rendering without changing the camera."""

import base64
import binascii
import io
import numpy as np
from PIL import Image, UnidentifiedImageError
from matplotlib.figure import Figure
from backend.models import BaseModel, Field
from typing import Literal


class SceneExportRequest(BaseModel):
    png: str = Field(max_length=135_000_000)
    format: Literal["png", "pdf", "svg"]
    width: int = Field(ge=64, le=4000)
    height: int = Field(ge=64, le=4000)
    scale: int = Field(ge=1, le=4)


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
            pixels = np.asarray(image.convert("RGBA"))
    except (binascii.Error, UnidentifiedImageError, OSError) as e:
        raise ValueError("Invalid PNG rendering.") from e
    return raw, pixels, size


def encode_scene(req, raw, pixels, size):
    if req.format == "png":
        return raw
    if req.format == "svg":
        # WebGL content is an embedded high-resolution image, not vector geometry.
        payload = base64.b64encode(raw).decode("ascii")
        width, height = size
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}px" height="{height}px" viewBox="0 0 {width} {height}">'
            f'<title>SeisCanvas 3D scene</title><image width="{width}" height="{height}" xlink:href="data:image/png;base64,{payload}"/></svg>'
        ).encode()
    dpi = 96 * req.scale
    width, height = size
    fig = Figure(figsize=(width / dpi, height / dpi), dpi=dpi)
    fig.figimage(pixels, origin="upper")
    output = io.BytesIO()
    fig.savefig(output, format="pdf", dpi=dpi, facecolor="white", pad_inches=0)
    return output.getvalue()


def package_scene(req):
    if req.width * req.height * req.scale**2 > 24_000_000:
        raise ValueError("Export exceeds 24 megapixels.")
    raw, pixels, size = decode_scene_png(req)
    return encode_scene(req, raw, pixels, size)
