"""Inspect real output: page alpha and vector coordinate furniture."""

import io
import xml.etree.ElementTree as ET

import pytest
from PIL import Image

from backend.models import Settings, ViewState
from backend.rendering import render


@pytest.mark.parametrize("canvas", ["fit", "fixed"])
@pytest.mark.parametrize("format", ["png", "svg", "pdf"])
@pytest.mark.parametrize("background", ["transparent", "white"])
def test_export_page_background_and_vector_coordinates(cube, canvas, format, background):
    data = render(cube, {}, ViewState(section_number=10), Settings(
        canvas=canvas, long_edge=600, width=60, height=40, format=format,
        background=background, font="DejaVu Sans",
    ))
    expected_alpha = 0 if background == "transparent" else 255
    if format == "png":
        with Image.open(io.BytesIO(data)).convert("RGBA") as image:
            assert image.getpixel((0, 0))[3] == expected_alpha
            assert image.getextrema()[3][1] == 255
    elif format == "svg":
        root = ET.fromstring(data)
        ns = {"s": "http://www.w3.org/2000/svg"}
        assert root.findall(".//s:image", ns)
        text = " ".join("".join(el.itertext()) for el in root.findall(".//s:text", ns))
        assert "Crossline" in text and "Time (ms)" in text
        # Figure and axes patches must not paint an opaque white background.
        page = root.find(".//s:g[@id='patch_1']/s:path", ns)
        assert page is not None
        assert ("fill: none" in page.attrib.get("style", "")) == (background == "transparent")
        assert root.findall(".//s:g[@id='matplotlib.axis_1']//s:path", ns)
    else:
        # Optional inspection tool, not a runtime dependency of the app.
        fitz = pytest.importorskip("fitz")
        with fitz.open(stream=data, filetype="pdf") as document:
            page = document[0]
            pixel = page.get_pixmap(alpha=True)
            assert pixel.samples[3] == expected_alpha
            assert page.get_images()
            assert page.get_fonts()  # embedded font resources, not image labels
            assert "Crossline" in page.get_text() and "Time (ms)" in page.get_text()
            assert page.get_drawings()  # coordinate axes / tick strokes
