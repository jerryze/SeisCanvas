"""Export queue: scientific naming, session storage, manifest and batch ZIP."""

import base64
import io
import json
import re
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import export_queue, naming
import backend.main as server


# --------------------------------------------------------------------------- naming


def test_naming_matches_the_specification_examples():
    assert (
        naming.inline_name("F3", 350, "Horizons6", "Seismic", 180, 100, 600)
        == "F3_2D_Inline_IL0350_Horizons6_Seismic_180x100mm_600dpi.png"
    )
    assert naming.horizons_label(["H1", "H2"]) == "H1-H2"
    assert (
        naming.inline_name("F3", 350, "SeismicOnly", "Seismic", 180, 100, 600)
        == "F3_2D_Inline_IL0350_SeismicOnly_Seismic_180x100mm_600dpi.png"
    )
    assert (
        naming.crossline_name("F3", 760, "H1-H3-H5", "Seismic", 180, 100, 600)
        == "F3_2D_Crossline_XL0760_H1-H3-H5_Seismic_180x100mm_600dpi.png"
    )
    assert naming.slice_label([350, 450], [600, 800], [1200]) == (
        "IL0350-0450_XL0600-0800_TWT1200ms"
    )
    assert (
        naming.multislice_name(
            "F3", "IL0350-0450_XL0600-0800_TWT1200ms", "Horizons6", 180, 100, 600
        )
        == "F3_3D_MultiSlice_IL0350-0450_XL0600-0800_TWT1200ms_Horizons6_180x100mm_600dpi.png"
    )
    assert (
        naming.horizon_surface_name("F3", "H1", "TWT", "Petrel", 180, 100, 600)
        == "F3_3D_HorizonSurface_H1_TWT_Petrel_180x100mm_600dpi.png"
    )
    assert (
        naming.horizon_map_name(
            "F3", "H1", "TWT", "FilledContour", "Petrel", 90, 80, 600
        )
        == "F3_HorizonMap_H1_TWT_FilledContour_Petrel_90x80mm_600dpi.png"
    )
    # A contour-only map is not filled, so the colormap is dropped.
    assert (
        naming.horizon_map_name("F3", "H1", "TWT", "Contour", "Petrel", 90, 80, 600, "pdf")
        == "F3_HorizonMap_H1_TWT_Contour_90x80mm_600dpi.pdf"
    )
    assert (
        naming.horizon_map_name("F3", "H1", "Amplitude", "Filled", "Seismic", 90, 80, 600)
        == "F3_HorizonMap_H1_Amplitude_Seismic_90x80mm_600dpi.png"
    )
    assert (
        naming.horizon_map_name(
            "F3", "H1", "Pred-vs-Ref", "SignedDifference", "RdBu", 90, 80, 600
        )
        == "F3_HorizonMap_H1_Pred-vs-Ref_SignedDifference_RdBu_90x80mm_600dpi.png"
    )
    assert (
        naming.horizon_profile_name("F3", "H1", "AB", "TWT", 120, 60, 600, "pdf")
        == "F3_HorizonProfile_H1_AB_TWT_120x60mm_600dpi.pdf"
    )


def test_naming_sanitizes_illegal_characters_and_collapses_separators():
    assert naming.sanitize('H 1: a/b*c?"<>|') == "H-1-a-b-c"
    assert naming.sanitize("A__B   C") == "A_B-C"
    assert naming.sanitize("   ") == "Untitled"
    assert naming.horizons_label([]) is None
    assert naming.horizons_label(["H1", "H2", "H3", "H4"]) == "Horizons4"


def test_naming_keeps_the_extension_and_appends_duplicate_suffixes():
    assert (
        naming.unique_name(
            "F3_2D_Inline_IL0350_SeismicOnly_Seismic_180x100mm_600dpi.png",
            {"f3_2d_inline_il0350_seismiconly_seismic_180x100mm_600dpi.png"},
        )
        == "F3_2D_Inline_IL0350_SeismicOnly_Seismic_180x100mm_600dpi_02.png"
    )
    assert naming.unique_name("a.png", {"a.png", "a_02.png"}) == "a_03.png"


def test_naming_shortens_overlong_names():
    name = naming.inline_name("D" * 200, 350, "Horizons12", "RedWhiteBlue", 180, 100, 600)
    assert len(name) <= naming.MAX_STEM + len(".png")
    assert name.endswith(".png")
    assert "180x100mm_600dpi" in name


# ----------------------------------------------------------------------------- queue


def png_data_url(width=400, height=300):
    buffer = io.BytesIO()
    Image.new("RGBA", (width, height), (20, 40, 80, 255)).save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def queue_body(state=None, settings=None, dataset="F3", **extra):
    body = {
        "kind": "2d",
        "dataset": dataset,
        "state": {"section_number": 12, "view_type": "inline", **(state or {})},
        "settings": {"format": "png", "dpi": 600, **(settings or {})},
    }
    body.update(extra)
    return body


def test_add_to_export_stores_a_rendered_figure_and_names_it(client):
    response = client.post("/api/export/queue", json=queue_body())
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["filename"] == "F3_2D_Inline_IL0012_SeismicOnly_Seismic_180x100mm_600dpi.png"
    assert item["view_type"] == "2d_inline"
    assert item["folder"] == "2D/Inline"
    assert item["detail"] == "PNG · 180 × 100 mm · 600 dpi"
    assert item["id"] == "exp_0001"
    assert item["created_at"] and item["temporary_path"]
    assert item["view_state"]["section_number"] == 12
    assert item["view_state"]["seismic"]["clip_percentile"] == 99.5

    listing = client.get("/api/export/queue").json()
    assert listing["count"] == 1
    assert listing["dataset"] == "F3"
    assert listing["session"].startswith("session_")

    # The stored file is the rendered PNG and is what Preview returns.
    preview = client.get(f"/api/export/queue/{item['id']}/file")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "image/png"
    assert preview.content.startswith(b"\x89PNG")
    with Image.open(io.BytesIO(preview.content)) as image:
        assert abs(image.width - 180 / 25.4 * 600) < 3

    # The session folder keeps the rendered figures and a live manifest.
    session = export_queue.session()
    assert session.folder == Path(export_queue.EXPORT_ROOT) / session.id
    assert (session.folder / export_queue.FIGURES).is_dir()
    on_disk = json.loads((session.folder / "manifest.json").read_text())
    assert on_disk["figure_count"] == 1
    assert on_disk["figures"][0]["name"] == item["filename"]
    assert Path(item["temporary_path"]).name.startswith("001_")


def test_duplicate_names_get_a_suffix_and_deleted_files_are_removed(client):
    first = client.post("/api/export/queue", json=queue_body()).json()
    second = client.post("/api/export/queue", json=queue_body()).json()
    assert second["filename"].endswith("_600dpi_02.png")
    assert first["filename"] != second["filename"]

    stored = first["temporary_path"]
    assert client.delete(f"/api/export/queue/{first['id']}").status_code == 200
    assert client.get(f"/api/export/queue/{first['id']}/file").status_code == 404
    listing = client.get("/api/export/queue").json()
    assert listing["count"] == 1 and listing["items"][0]["index"] == 1


def test_crossline_and_horizon_content_naming(client):
    body = queue_body(
        state={"view_type": "crossline", "section_number": 30},
        dataset="F3",
    )
    item = client.post("/api/export/queue", json=body).json()
    assert item["view_type"] == "2d_crossline"
    assert item["folder"] == "2D/Crossline"
    assert item["filename"].startswith("F3_2D_Crossline_XL0030_")

    with_horizon = queue_body(
        state={"horizons": [{"id": "h", "name": "my horizon"}]},
    )
    item = client.post("/api/export/queue", json=with_horizon).json()
    assert "_h_Seismic_" in item["filename"]


def test_rename_changes_only_the_exported_file_name(client):
    item = client.post("/api/export/queue", json=queue_body()).json()
    renamed = client.patch(
        f"/api/export/queue/{item['id']}",
        json={"filename": "Figure 1: inline/350"},
    ).json()
    assert renamed["filename"] == "Figure-1-inline-350.png"
    assert renamed["view_type"] == item["view_type"]
    assert renamed["index"] == item["index"]
    assert client.get(f"/api/export/queue/{item['id']}/file").content.startswith(b"\x89PNG")

    # A rename that already exists in the session is disambiguated.
    other = client.post("/api/export/queue", json=queue_body()).json()
    clash = client.patch(
        f"/api/export/queue/{other['id']}", json={"filename": "Figure-1-inline-350.png"}
    ).json()
    assert clash["filename"] == "Figure-1-inline-350_02.png"
    assert client.patch("/api/export/queue/missing", json={"filename": "x"}).status_code == 404
    assert client.patch(
        f"/api/export/queue/{item['id']}", json={"filename": "  "}
    ).status_code == 422


def test_dataset_falls_back_to_the_segy_file_name(client):
    item = client.post("/api/export/queue", json=queue_body(dataset=None)).json()
    assert item["dataset"] == "tiny"
    assert item["filename"].startswith("tiny_2D_Inline_")
    item = client.post("/api/export/queue", json=queue_body(dataset="My Project")).json()
    assert item["dataset"] == "My-Project"


def test_horizon_map_is_queued_with_its_contour_parameters(client):
    body = {
        "kind": "map",
        "dataset": "F3",
        "state": {"horizon": "h", "display": "filled_contour", "interval": 2},
        "settings": {"format": "png", "width": 90, "height": 80, "dpi": 600},
    }
    item = client.post("/api/export/queue", json=body).json()
    assert item["view_type"] == "horizon_map"
    assert item["folder"] == "HorizonMap"
    assert item["filename"] == "F3_HorizonMap_h_TWT_FilledContour_Petrel_90x80mm_600dpi.png"

    manifest_body = {
        "kind": "map",
        "dataset": "F3",
        "state": {"horizon": "missing"},
        "settings": {"format": "png"},
    }
    assert client.post("/api/export/queue", json=manifest_body).status_code == 400


def test_three_dimensional_items_keep_their_own_format(client):
    body = {
        "kind": "3d",
        "dataset": "F3",
        "png": png_data_url(),
        "format": "pdf",
        "width_px": 400,
        "height_px": 300,
        "scale": 1,
        "settings": {"width": 180, "height": 100, "dpi": 300},
        "state": {
            "view_mode": "3d",
            "slices": {
                "inline": [{"id": "a", "position": 10}, {"id": "b", "position": 12}],
                "crossline": [{"id": "c", "position": 30}],
                "time": [],
            },
            "scene": {"camera": {"eye": {"x": 1, "y": 2, "z": 3}}},
        },
    }
    item = client.post("/api/export/queue", json=body).json()
    assert item["view_type"] == "3d_multislice"
    assert item["folder"] == "3D"
    assert item["format"] == "pdf"
    assert item["pixel_size"] == [400, 300]
    assert item["detail"] == "PDF · 400 × 300 px · 1×"
    assert item["filename"] == "F3_3D_MultiSlice_IL0010-0012_XL0030_180x100mm_300dpi.pdf"

    preview = client.get(f"/api/export/queue/{item['id']}/file")
    assert preview.headers["content-type"] == "application/pdf"
    assert preview.content.startswith(b"%PDF")


def test_three_dimensional_scene_with_only_surfaces_is_a_horizon_surface(client):
    body = {
        "kind": "3d",
        "dataset": "F3",
        "png": png_data_url(),
        "format": "png",
        "width_px": 400,
        "height_px": 300,
        "scale": 1,
        "settings": {"width": 180, "height": 100, "dpi": 300},
        "state": {
            "view_mode": "3d",
            "slices": {"inline": [{"id": "a", "position": 10, "visible": False}]},
            "horizons": [
                {"id": "h", "name": "H1", "display_mode": "full_surface", "opacity": .5}
            ],
        },
    }
    item = client.post("/api/export/queue", json=body).json()
    assert item["view_type"] == "3d_horizon_surface"
    assert item["filename"] == "F3_3D_HorizonSurface_H1_TWT_Petrel_180x100mm_300dpi.png"
    assert client.get(f"/api/export/queue/{item['id']}/file").content.startswith(b"\x89PNG")


def test_three_dimensional_request_rejects_a_mismatched_png(client):
    body = {
        "kind": "3d",
        "png": png_data_url(400, 300),
        "format": "png",
        "width_px": 800,
        "height_px": 600,
        "scale": 1,
        "settings": {"width": 180, "height": 100},
        "state": {"view_mode": "3d"},
    }
    response = client.post("/api/export/queue", json=body)
    assert response.status_code == 400 and "dimensions" in response.json()["detail"]


# --------------------------------------------------------------------------- archive


def test_export_all_builds_a_categorised_zip_with_a_manifest(client):
    inline = client.post("/api/export/queue", json=queue_body()).json()
    crossline = client.post(
        "/api/export/queue",
        json=queue_body(state={"view_type": "crossline", "section_number": 30}),
    ).json()
    horizon_map = client.post(
        "/api/export/queue",
        json={
            "kind": "map",
            "dataset": "F3",
            "state": {"horizon": "h"},
            "settings": {"format": "pdf", "width": 90, "height": 80, "dpi": 600},
        },
    ).json()
    scene = client.post(
        "/api/export/queue",
        json={
            "kind": "3d",
            "dataset": "F3",
            "png": png_data_url(),
            "format": "png",
            "width_px": 400,
            "height_px": 300,
            "scale": 1,
            "settings": {"width": 180, "height": 100, "dpi": 300},
            "state": {
                "view_mode": "3d",
                "slices": {"time": [{"id": "t", "position": 204}]},
                "scene": {
                    "aspect_ratio": [1, 1, 0.7],
                    "quality": 256,
                    "camera": {
                        "eye": {"x": 1.0, "y": 2.0, "z": 3.0},
                        "up": {"x": 0, "y": 0, "z": 1},
                        "center": {"x": 0, "y": 0, "z": 0},
                    },
                },
                "horizons": [
                    {
                        "id": "h",
                        "name": "H1",
                        "display_mode": "full_surface",
                        "lighting": False,
                        "opacity": 0.6,
                    }
                ],
            },
        },
    ).json()

    response = client.post("/api/export/archive")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    zip_name = response.headers["x-export-filename"]
    assert re.fullmatch(r"SeisCanvas_F3_Export_\d{8}_\d{4}\.zip", zip_name)

    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        names = archive.namelist()
        assert f"2D/Inline/{inline['filename']}" in names
        assert f"2D/Crossline/{crossline['filename']}" in names
        assert f"HorizonMap/{horizon_map['filename']}" in names
        assert f"3D/{scene['filename']}" in names
        assert "export_manifest.json" in names

        manifest = json.loads(archive.read("export_manifest.json"))
        assert manifest["application"] == "SeisCanvas"
        assert manifest["dataset"] == "F3"
        assert manifest["figure_count"] == 4
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", manifest["exported_at"])

        figures = manifest["figures"]
        assert [figure["id"] for figure in figures] == [1, 2, 3, 4]
        assert figures[0]["file"] == f"2D/Inline/{inline['filename']}"
        assert figures[0]["inline"] == 12
        assert figures[0]["view"] == "2d_inline"
        assert figures[0]["seismic_colormap"] == "seismic"
        assert figures[0]["clip_percentile"] == 99.5
        assert figures[0]["reverse_polarity"] is False
        assert figures[0]["width_mm"] == 180 and figures[0]["dpi"] == 600
        assert figures[0]["colorbar_range"][0] < figures[0]["colorbar_range"][1]
        assert figures[0]["render"]["font"] == "Times New Roman"
        # Publication rendering defaults travel with the queued figure.
        assert figures[0]["render"]["interpolation"] == "bicubic"
        assert figures[0]["render"]["resolution"] == "export"
        assert figures[1]["crossline"] == 30
        assert figures[2]["contour_interval"] == 10 and figures[2]["colorbar"] is True
        assert figures[3]["slices"]["time"] == [204]
        assert figures[3]["render"]["font"] == "Times New Roman"
        assert figures[3]["pixel_size"] == [400, 300]
        assert figures[3]["camera"]["eye"] == {"x": 1.0, "y": 2.0, "z": 3.0}
        assert figures[3]["vertical_exaggeration"] == 0.7
        assert figures[3]["lighting"] is False
        assert figures[3]["opacity"] == {"H1": 0.6}
        assert figures[3]["view_state"]["slices"]["time"][0]["position"] == 204

        # Preview must be byte-identical to the file inside the ZIP.
        for item, figure in zip([inline, crossline, horizon_map, scene], figures):
            preview = client.get(f"/api/export/queue/{item['id']}/file").content
            assert archive.read(figure["file"]) == preview


def test_archive_uses_a_batch_name_for_multiple_datasets(client):
    client.post("/api/export/queue", json=queue_body(dataset="F3"))
    client.post(
        "/api/export/queue",
        json=queue_body(state={"view_type": "crossline", "section_number": 30}, dataset="XH"),
    )
    response = client.post("/api/export/archive")
    assert re.fullmatch(
        r"SeisCanvas_BatchExport_\d{8}_\d{4}\.zip", response.headers["x-export-filename"]
    )
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("export_manifest.json"))
    assert manifest["dataset"] is None and manifest["datasets"] == ["F3", "XH"]


def test_non_ascii_dataset_names_stay_downloadable(client):
    name = client.post(
        "/api/export/queue",
        json=queue_body(state={"horizons": []}, dataset="塔里木 F3"),
    ).json()
    assert name["dataset"] == "塔里木-F3"
    response = client.post("/api/export/archive")
    assert response.status_code == 200
    from urllib.parse import unquote

    header = response.headers["x-export-filename"]
    assert header.isascii()
    assert unquote(header).startswith("SeisCanvas_塔里木-F3_Export_")
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert any(name["filename"] in entry for entry in archive.namelist())


def test_clear_queue_removes_every_stored_file(client):
    for _ in range(3):
        client.post("/api/export/queue", json=queue_body())
    assert client.get("/api/export/queue").json()["count"] == 3
    assert client.post("/api/export/archive").status_code == 200

    assert client.delete("/api/export/queue").status_code == 200
    listing = client.get("/api/export/queue").json()
    assert listing["count"] == 0 and listing["items"] == []
    assert client.post("/api/export/archive").status_code == 400

    session = export_queue.session()
    assert list((session.folder / export_queue.FIGURES).iterdir()) == []


def test_queue_requires_loaded_data():
    server.survey = None
    client = TestClient(server.app)
    assert client.post("/api/export/queue", json=queue_body()).status_code == 400
    assert client.post("/api/export/archive").status_code == 400


def test_session_prunes_old_folders(tmp_path, monkeypatch):
    monkeypatch.setattr(export_queue, "EXPORT_ROOT", tmp_path / "root")
    for _ in range(export_queue.KEEP_SESSIONS + 3):
        export_queue.reset()
        export_queue.session()
    folders = [p for p in (tmp_path / "root").iterdir() if p.is_dir()]
    assert len(folders) <= export_queue.KEEP_SESSIONS
