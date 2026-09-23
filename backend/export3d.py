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
    format: Literal["pdf", "svg"]
    width: int = Field(ge=400, le=4000)
    height: int = Field(ge=300, le=4000)
    scale: int = Field(ge=1, le=4)


def package_scene(req):
    if req.width * req.height * req.scale**2 > 24_000_000:
        raise ValueError("Export exceeds 24 megapixels.")
    prefix = "data:image/png;base64,"
    if not req.png.startswith(prefix):
        raise ValueError("Expected a PNG rendering.")
    try:
        raw = base64.b64decode(req.png[len(prefix) :], validate=True)
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG" or image.size != (
                req.width * req.scale,
                req.height * req.scale,
            ):
                raise ValueError("PNG dimensions do not match the export settings.")
            pixels = np.asarray(image.convert("RGBA"))
    except (binascii.Error, UnidentifiedImageError, OSError) as e:
        raise ValueError("Invalid PNG rendering.") from e
    if req.format == "svg":
        # WebGL content is an embedded high-resolution image, not vector geometry.
        payload = base64.b64encode(raw).decode("ascii")
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{req.width}px" height="{req.height}px" viewBox="0 0 {req.width} {req.height}">'
            f'<title>SeisCanvas 3D scene</title><image width="{req.width}" height="{req.height}" xlink:href="data:image/png;base64,{payload}"/></svg>'
        ).encode()
    dpi = 96 * req.scale
    fig = Figure(figsize=(req.width / 96, req.height / 96), dpi=dpi)
    fig.figimage(pixels, origin="upper")
    output = io.BytesIO()
    fig.savefig(output, format="pdf", dpi=dpi, facecolor="white", pad_inches=0)
    return output.getvalue()
