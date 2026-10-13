"""Preserve the supplied palette across browser previews and figure exports."""

import json
from pathlib import Path

import pytest
from matplotlib.colors import to_hex

from backend.style import get_cmap


REFERENCE = json.loads(
    (Path(__file__).parents[1] / "backend/colormaps/reference_seismic.json").read_text()
)


def test_catalog_and_renderer_preserve_every_extracted_color(client):
    colors = [color.lower() for _, color in REFERENCE["colorscale"]]
    assert len(colors) == 256
    assert colors[0] == "#c5262d" and colors[-1] == "#0c0c0c"
    catalog = client.get("/api/catalog").json()
    palette = catalog["colormaps"]["reference_seismic"]
    assert [color for _, color in palette] == colors
    assert [position for position, _ in palette] == [i / 255 for i in range(256)]
    for reverse in (False, True):
        cmap = get_cmap("reference_seismic", reverse)
        actual = [to_hex(cmap(i / 255)) for i in range(256)]
        assert actual == (list(reversed(colors)) if reverse else colors)


@pytest.mark.parametrize("reverse", [False, True])
def test_new_palette_works_in_sections_scenes_and_export_queue(client, reverse):
    seismic = {"colormap": "reference_seismic", "reverse_colormap": reverse}
    state = {"section_number": 12, "seismic": seismic}
    section = client.post("/api/section", json=state)
    assert section.status_code == 200
    default = client.post("/api/section", json={"section_number": 12}).json()
    # Reference amplitude metadata must not override the existing data range.
    assert (section.json()["vmin"], section.json()["vmax"]) == (
        default["vmin"], default["vmax"]
    )
    scene = client.post("/api/scene", json={
        "seismic": seismic,
        "slices": {"inline": [{"id": "il", "position": 12}]},
    })
    assert scene.status_code == 200 and len(scene.json()["slices"]) == 1
    queued = client.post("/api/export/queue", json={
        "kind": "2d", "state": state,
        "settings": {"format": "png", "canvas": "fixed", "width": 60, "height": 40, "dpi": 300},
    })
    assert queued.status_code == 200
    item = queued.json()
    assert "ReferenceSeismic" in item["filename"]
    assert item["view_state"]["seismic"]["colormap"] == "reference_seismic"
    assert item["view_state"]["seismic"]["reverse_colormap"] is reverse


@pytest.mark.parametrize("fmt,magic", [("png", b"\x89PNG"), ("pdf", b"%PDF"), ("svg", b"<?xml")])
def test_new_palette_exports_all_formats(client, fmt, magic):
    response = client.post("/api/export", json={
        "state": {"section_number": 12, "seismic": {
            "colormap": "reference_seismic",
        }},
        "settings": {"format": fmt, "canvas": "fixed", "width": 60, "height": 40, "dpi": 300},
    })
    assert response.status_code == 200
    assert response.content.startswith(magic)
