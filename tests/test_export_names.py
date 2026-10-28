"""All figure types share preview, custom naming and frozen rendered bytes."""
from copy import deepcopy
from pathlib import Path

import pytest

from test_export_routes import isolated_exports
from test_export_restore import request_for


@pytest.mark.parametrize("kind", ["2d", "3d", "map", "profile"])
@pytest.mark.parametrize("fmt", ["png", "pdf", "svg"])
def test_all_figures_preview_and_preserve_custom_names(isolated_exports, kind, fmt):
    client, _, _, headers, _ = isolated_exports
    body = request_for(kind)
    body["settings"]["format"] = fmt
    if kind == "3d":
        body["format"] = fmt
    preview_body = deepcopy(body)
    # Naming a 3D figure never requires a screenshot or camera capture.
    for key in ("png", "width_px", "height_px", "scale", "vector_overlay"):
        preview_body.pop(key, None)
    read_headers = {k: v for k, v in headers.items() if k != "X-SeisCanvas-Revision"}
    preview = client.post("/api/export/name", headers=read_headers, json=preview_body)
    assert preview.status_code == 200, preview.text
    expected_stem = {"2d": "2D_IL12", "3d": "3D_IL12", "map": "层位图_h", "profile": "AB剖面_IL10-12_XL30-33"}[kind]
    if kind == "map":
        expected_stem = "层位图_" + next(iter(isolated_exports[-1].values())).name
    assert preview.json()["filename"] == f"{expected_stem}.{fmt}"
    assert client.get("/api/export/queue", headers=headers).json()["count"] == 0

    body["filename"] = preview_body["filename"] = "对比.v2_180x100mm_300dpi.png"
    expected = f"对比.v2_180x100mm_300dpi.{fmt}"
    assert client.post("/api/export/name", headers=read_headers, json=preview_body).json()["filename"] == expected
    saved = client.post("/api/export/queue", headers=headers, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["filename"] == expected
    next_preview = client.post("/api/export/name", headers=read_headers, json=preview_body).json()["filename"]
    assert next_preview == f"对比.v2_180x100mm_300dpi_02.{fmt}"
    if fmt == "png":
        original = Path(saved.json()["temporary_path"]).read_bytes()
        body.pop("filename")
        unchanged = client.post("/api/export/queue", headers=headers, json=body)
        assert unchanged.status_code == 200, unchanged.text
        assert Path(unchanged.json()["temporary_path"]).read_bytes() == original
    preview_body["filename"] = "  "
    assert client.post("/api/export/name", headers=read_headers, json=preview_body).status_code == 422
