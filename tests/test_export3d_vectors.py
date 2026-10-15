"""Exact 3D raster preservation with transparent pages and vector furniture."""

import base64
import io
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw
import pytest
from pydantic import ValidationError

from backend.export3d import decode_scene_png, encode_scene, package_scene
from backend.models import SceneExportRequest, SceneVectorOverlay, SceneVectorPath


OVERLAY = {
    "paths": [
        {"points": [[4, 4], [12, 4], [12, 8]], "color": "#000000"},
        {"points": [[4, 4], [12, 8], [4, 8]], "color": "#000000"},
        {"points": [[4, 8], [8, 8], [8, 16]], "color": "#000000"},
        {"points": [[4, 8], [8, 16], [4, 16]], "color": "#000000"},
    ],
    "lines": [
        {"points": [[5, 30], [59, 30]], "color": "#0000ff", "width": 2, "layer": "back"},
        {"points": [[5, 38], [59, 38]], "color": "#00ff00", "width": 2, "layer": "front"},
    ],
    "labels": ["Crossline", "Inline", "Time (ms)", "<source label>"],
}


def source_png(background="transparent"):
    image = Image.new("RGBA", (64, 64), "white" if background == "white" else (0, 0, 0, 0))
    ImageDraw.Draw(image).rectangle((20, 20, 43, 43), fill=(255, 0, 0, 255))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def request(fmt, background="transparent", overlay=OVERLAY):
    # Vector formats leave the actor raster clear; the wrapper paints a chosen
    # opaque page underneath back vectors. PNG has its background applied in UI.
    raw = source_png(background if fmt == "png" else "transparent")
    return SceneExportRequest(png="data:image/png;base64," + base64.b64encode(raw).decode(),
                              format=fmt, width=64, height=64, scale=1,
                              dpi=96, background=background, vector_overlay=overlay)


def pdf_pixels(data):
    fitz = pytest.importorskip("fitz")
    document = fitz.open(stream=data, filetype="pdf")
    page = document[0]
    pixmap = page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72), alpha=True)
    pixels = np.frombuffer(pixmap.samples, np.uint8).reshape(pixmap.height, pixmap.width, 4).copy()
    return document, page, pixels


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
@pytest.mark.parametrize("background", ["white", "transparent"])
def test_scene_background_and_vector_layers(fmt, background):
    req = request(fmt, background, overlay=None if fmt == "png" else OVERLAY)
    output = package_scene(req)
    if fmt == "png":
        with Image.open(io.BytesIO(output)) as image:
            assert image.getpixel((0, 0))[3] == (0 if background == "transparent" else 255)
    elif fmt == "svg":
        root = ET.fromstring(output)
        ns = {"svg": "http://www.w3.org/2000/svg"}
        rects = root.findall("svg:rect", ns)
        assert bool(rects) is (background == "white")
        children = list(root)
        back = root.find("svg:g[@id='axes-back']", ns)
        front = root.find("svg:g[@id='axes-front']", ns)
        raster = root.find("svg:image", ns)
        assert children.index(back) < children.index(raster) < children.index(front)
        # Four font triangles become one compound glyph-outline path.
        paths = front.findall("svg:path", ns)
        assert len(paths) == 1 and paths[0].attrib["d"].count("M") == 4
        assert len(back.findall("svg:polyline", ns)) == 1
        assert len(front.findall("svg:polyline", ns)) == 1
        href = raster.attrib["{http://www.w3.org/1999/xlink}href"]
        with Image.open(io.BytesIO(base64.b64decode(href.split(",", 1)[1]))) as actor:
            assert actor.getpixel((0, 0))[3] == 0
        assert root.find("svg:desc", ns).text.endswith("<source label>")
    else:
        document, page, pixels = pdf_pixels(output)
        try:
            assert pixels[0, 0, 3] == (0 if background == "transparent" else 255)
            assert np.array_equal(pixels[30, 32], [255, 0, 0, 255])  # actor hides back axis
            assert np.array_equal(pixels[30, 10], [0, 0, 255, 255])  # exposed back axis
            assert np.array_equal(pixels[38, 32], [0, 255, 0, 255])  # front tick stays above actor
            assert len(page.get_images(full=True)) == 1
            assert page.get_images(full=True)[0][1] > 0  # source alpha is a PDF soft mask
            assert len(page.get_drawings()) >= 3  # glyph outlines plus real vector lines
        finally:
            document.close()


def test_vector_overlay_validation_rejects_nonfinite_coordinates_and_unbounded_geometry():
    for invalid in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(ValidationError):
            SceneVectorPath(points=[(invalid, 0), (1, 0), (0, 1)])
    with pytest.raises(ValidationError):
        SceneVectorPath(points=[(0, 0), (1, 0), (0, 1)], color='url("external.svg")')
    path = SceneVectorPath(points=[(0, 0)] * 4096)
    with pytest.raises(ValidationError, match="500000 vertices"):
        SceneVectorOverlay(paths=[path] * 123)


def test_png_packaging_preserves_idat_and_native_rendering():
    req = request("png", overlay=None)
    raw, pixels, size = decode_scene_png(req)
    assert pixels is None
    output = encode_scene(req, raw, pixels, size)
    with Image.open(io.BytesIO(raw)) as source, Image.open(io.BytesIO(output)) as result:
        np.testing.assert_array_equal(result, source)
    # The pHYs chunk adds DPI metadata; compressed pixel bytes are untouched.
    def idat(data):
        import struct
        chunks, offset = [], 8
        while offset < len(data):
            count = struct.unpack(">I", data[offset:offset + 4])[0]
            if data[offset + 4:offset + 8] == b"IDAT":
                chunks.append(data[offset + 8:offset + 8 + count])
            offset += count + 12
        return chunks
    assert idat(output) == idat(raw)


@pytest.mark.parametrize("fmt", ["svg", "pdf"])
def test_3d_queue_passes_background_and_vector_furniture(client, fmt):
    import backend.export_queue as queue
    req = request(fmt)
    response = client.post("/api/export/queue", json={
        "kind": "3d", "png": req.png, "format": fmt, "width_px": 64, "height_px": 64,
        "scale": 1, "render_dpi": 96, "vector_overlay": OVERLAY,
        "settings": {"canvas": "fit", "long_edge": 600, "background": "transparent"},
        "state": {"view_mode": "3d"},
    })
    assert response.status_code == 200, response.text
    item = response.json()
    data = Path(item["temporary_path"]).read_bytes()
    manifest = queue.session().manifest()["figures"][0]
    assert manifest["render"]["background"] == "transparent"
    assert manifest["vector_axes"] and manifest["axis_text_representation"] == "glyph_outlines"
    if fmt == "svg":
        root = ET.fromstring(data)
        assert not root.findall("{http://www.w3.org/2000/svg}rect")
        assert root.findall(".//{http://www.w3.org/2000/svg}path")
    else:
        document, page, pixels = pdf_pixels(data)
        try:
            assert pixels[0, 0, 3] == 0 and len(page.get_drawings()) >= 3
        finally:
            document.close()
