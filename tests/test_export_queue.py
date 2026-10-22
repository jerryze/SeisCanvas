"""Export queue: scientific naming, session storage, manifest and batch ZIP."""

import base64
import io
import json
import re
import zipfile
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import export_queue, naming
from backend.core import Horizon
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
        "IL0350-0450_XL0600-0800_Time1200ms"
    )
    assert (
        naming.multislice_name(
            "F3", "IL0350-0450_XL0600-0800_Time1200ms", "Horizons6", 180, 100, 600
        )
        == "F3_3D_MultiSlice_IL0350-0450_XL0600-0800_Time1200ms_Horizons6_180x100mm_600dpi.png"
    )
    assert (
        naming.horizon_surface_name("F3", "H1", "Time", "Petrel", 180, 100, 600)
        == "F3_3D_HorizonSurface_H1_Time_Petrel_180x100mm_600dpi.png"
    )
    assert (
        naming.horizon_map_name(
            "F3", "H1", "Time", "FilledContour", "Petrel", 90, 80, 600
        )
        == "F3_HorizonMap_H1_Time_FilledContour_Petrel_90x80mm_600dpi.png"
    )
    # A contour-only map is not filled, so the colormap is dropped.
    assert (
        naming.horizon_map_name("F3", "H1", "Time", "Contour", "Petrel", 90, 80, 600, "pdf")
        == "F3_HorizonMap_H1_Time_Contour_90x80mm_600dpi.pdf"
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
        naming.horizon_profile_name("F3", "H1", "AB", "Time", 120, 60, 600, "pdf")
        == "F3_HorizonProfile_H1_AB_Time_120x60mm_600dpi.pdf"
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


@pytest.mark.parametrize("format", ["png", "svg", "pdf"])
@pytest.mark.parametrize("background,wiggle", [(True, True), (True, False), (False, True), (False, False)])
def test_2d_trace_overlays_survive_queue_and_archive(client, format, background, wiggle):
    seismic = {
        "wiggle": True, "variable_area": True, "wiggle_gain": 1.7,
        "variable_area_color": "#123456", "reverse_polarity": True,
        "clip_mode": "manual", "vmin": -1500, "vmax": 1500,
        "background_interpolation": background, "wiggle_interpolation": wiggle,
    }
    state = {
        "seismic": seismic, "trace_viewport_width": 480, "trace_viewport_height": 320,
        "x_range": [30, 38], "time_range": [201, 211],
    }
    response = client.post("/api/export/queue", json=queue_body(
        state=state,
        settings={"format": format, "canvas": "fit", "long_edge": 600},
    ))
    assert response.status_code == 200, response.text
    item = response.json()
    for key, value in seismic.items():
        assert item["view_state"]["seismic"][key] == value
    assert item["view_state"]["trace_viewport_width"] == 480
    assert item["view_state"]["trace_viewport_height"] == 320
    original = client.get(f"/api/export/queue/{item['id']}/file").content
    assert original.startswith({"png": b"\x89PNG", "pdf": b"%PDF", "svg": b"<?xml"}[format])

    # Queue figures retain the exact settings and rendered bytes at add time.
    client.post("/api/section", json={"section_number": 12, "seismic": {"wiggle": False}})
    archived = client.post("/api/export/archive")
    assert archived.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archived.content)) as archive:
        assert archive.read(f"2D/Inline/{item['filename']}") == original
        figure = json.loads(archive.read("export_manifest.json"))["figures"][0]
        for key in ("wiggle", "variable_area", "wiggle_gain", "variable_area_color", "background_interpolation", "wiggle_interpolation"):
            assert figure[key] == seismic[key]
        assert figure["trace_viewport_width"] == 480
        assert figure["trace_viewport_height"] == 320
        assert figure["background_algorithm"] == ("sinc8_time_linear_trace" if background else "native")


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


@pytest.mark.parametrize('include_profile', [False, True])
def test_horizon_map_queue_keeps_ab_overlay_in_file_and_snapshot(client, include_profile):
    profile = {'a': [10, 30], 'b': [12, 33], 'path_start': [10, 30], 'path_end': [12, 33]}
    response = client.post('/api/export/queue', json={
        'kind': 'map', 'state': {'horizon': 'h'},
        'settings': {'format': 'svg', 'long_edge': 600},
        'profile': profile if include_profile else None,
    })
    assert response.status_code == 200, response.text
    item = response.json()
    assert export_queue.session().items[-1]['summary']['profile'] == (profile if include_profile else None)
    assert item['view_state']['profile'] == (profile if include_profile else None)
    content = Path(item['temporary_path']).read_bytes()
    assert (b'id="map-ab-line"' in content) is include_profile


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
    assert item["filename"] == "F3_HorizonMap_h_Time_FilledContour_Petrel_90x80mm_600dpi.png"

    manifest_body = {
        "kind": "map",
        "dataset": "F3",
        "state": {"horizon": "missing"},
        "settings": {"format": "png"},
    }
    assert client.post("/api/export/queue", json=manifest_body).status_code == 400


@pytest.fixture
def difference_export_pair(client, tmp_path):
    for key, name, offset in [("ref", "Ref H/1", 0), ("comp", "Pred:H2", 3)]:
        path = tmp_path / f"{key}.txt"
        path.write_text(
            "\n".join(f"{y} {x} {204 + y + x + offset}" for y in (10, 12) for x in (30, 33))
        )
        server.horizons[key] = Horizon(path, name)
    # The geometry horizon is independent of both members of the pair.
    server.horizons["h"].name = "Grid/H 1"
    yield
    server.horizons.pop("ref", None)
    server.horizons.pop("comp", None)


def difference_queue_body(**state):
    return {
        "kind": "map",
        "dataset": "F3",
        "state": {
            "horizon": "h",
            "color_by": "difference",
            "difference_reference": "ref",
            "difference_comparison": "comp",
            "display": "filled_contour",
            "colormap": "RdBu",
            **state,
        },
        "settings": {"canvas": "fixed", "format": "png", "width": 60, "height": 50, "dpi": 300},
    }


@pytest.mark.parametrize("difference_type,label,colormap", [
    ("signed", "SignedDifference", "RdBu"),
    ("absolute", "AbsoluteError", "viridis"),
])
@pytest.mark.parametrize("display,label_display", [
    ("filled", "Filled"), ("contour", "Contour"), ("filled_contour", "FilledContour"),
])
def test_difference_export_names_the_pair_type_and_display(
    client, difference_export_pair, difference_type, label, colormap, display, label_display,
):
    response = client.post("/api/export/queue", json=difference_queue_body(
        difference_type=difference_type, colormap=colormap, display=display,
    ))
    assert response.status_code == 200, response.text
    item = response.json()
    color = "" if display == "contour" else f"_{naming.colormap_label(colormap)}"
    assert item["filename"] == (
        f"F3_HorizonMap_Grid-H-1_Pred-H2-vs-Ref-H-1_{label}_{label_display}{color}_60x50mm_300dpi.png"
    )
    assert client.get(f"/api/export/queue/{item['id']}/file").content.startswith(b"\x89PNG")
    manifest = export_queue.session().manifest()["figures"][0]
    assert manifest["name"] == item["filename"]
    assert manifest["horizon"] == "Grid/H 1"
    assert manifest["display"] == display
    assert manifest["difference"] == {
        "reference": "ref", "reference_name": "Ref H/1",
        "comparison": "comp", "comparison_name": "Pred:H2",
        "type": difference_type, "operation": "comparison - reference",
    }


def test_difference_export_swap_duplicate_and_renamed_horizon(client, difference_export_pair):
    first = client.post("/api/export/queue", json=difference_queue_body()).json()
    swapped = client.post("/api/export/queue", json=difference_queue_body(
        difference_reference="comp", difference_comparison="ref",
    )).json()
    assert "_Ref-H-1-vs-Pred-H2_SignedDifference_" in swapped["filename"]
    assert not swapped["filename"].endswith("_02.png")
    duplicate = client.post("/api/export/queue", json=difference_queue_body()).json()
    assert duplicate["filename"] == first["filename"].removesuffix(".png") + "_02.png"

    assert client.patch("/api/horizons/comp", json={"name": "Updated Prediction"}).status_code == 200
    renamed = client.post("/api/export/queue", json=difference_queue_body()).json()
    assert "_Updated-Prediction-vs-Ref-H-1_" in renamed["filename"]
    figures = export_queue.session().manifest()["figures"]
    assert figures[0]["name"] == first["filename"]
    assert figures[0]["difference"]["comparison_name"] == "Pred:H2"
    assert figures[-1]["difference"]["comparison_name"] == "Updated Prediction"


@pytest.mark.parametrize("missing", ["difference_reference", "difference_comparison"])
def test_difference_export_rejects_a_missing_pair(client, difference_export_pair, missing):
    response = client.post("/api/export/queue", json=difference_queue_body(**{missing: "missing"}))
    assert response.status_code == 400
    assert client.get("/api/export/queue").json()["count"] == 0


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
    assert item["filename"] == "F3_3D_HorizonSurface_H1_Time_Petrel_180x100mm_300dpi.png"
    assert client.get(f"/api/export/queue/{item['id']}/file").content.startswith(b"\x89PNG")


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
def test_three_dimensional_amplitude_surface_keeps_coloring_in_export(client, fmt):
    body = {"kind": "3d", "dataset": "F3", "png": png_data_url(), "format": fmt,
            "width_px": 400, "height_px": 300, "scale": 1,
            "settings": {"width": 180, "height": 100, "dpi": 300},
            "state": {"view_mode": "3d", "horizons": [{"id": "h", "name": "H1", "color_by": "amplitude"}],
                      "seismic": {"colormap": "seismic", "reverse_polarity": True}}}
    response = client.post("/api/export/queue", json=body)
    assert response.status_code == 200, response.text
    item = response.json()
    assert "_Amplitude_Seismic_" in item["filename"]
    assert item["view_state"]["horizons"][0]["color_by"] == "amplitude"
    assert item["view_state"]["seismic"]["reverse_polarity"] is True
    assert export_queue.session().manifest()["figures"][0]["horizon_amplitude_colormap"] == "seismic"
    preview = client.get(f"/api/export/queue/{item['id']}/file")
    assert preview.content.startswith({"png": b"\x89PNG", "pdf": b"%PDF", "svg": b"<svg"}[fmt])


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
        assert figures[2]["contour_interval"] is None
        assert figures[2]["contour_interval_auto"] is True  # Auto 1/2/5 step.
        assert figures[2]["colorbar"] is True
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


def test_archive_selected_figures_keeps_queue_order_and_saved_bytes(client):
    responses = [
        client.post("/api/export/queue", json=queue_body(
            state={"section_number": section}, dataset=dataset,
            settings={"width": 40, "height": 30, "dpi": 300},
        ))
        for section, dataset in [(10, "F3"), (12, "XH"), (10, "F3")]
    ]
    assert all(response.status_code == 200 for response in responses), [r.text for r in responses]
    items = [response.json() for response in responses]
    original = client.get("/api/export/queue").json()
    response = client.post("/api/export/archive", json={
        "item_ids": [items[2]["id"], items[1]["id"]],
    })
    assert response.status_code == 200, response.text
    assert response.headers["x-export-figures"] == "2"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("export_manifest.json"))
        assert manifest["figure_count"] == 2
        assert manifest["dataset"] is None
        assert manifest["datasets"] == ["XH", "F3"]
        assert [figure["name"] for figure in manifest["figures"]] == [item["filename"] for item in items[1:]]
        assert len(archive.namelist()) == 3
        for figure, item in zip(manifest["figures"], items[1:]):
            saved = client.get(f"/api/export/queue/{item['id']}/file").content
            assert archive.read(figure["file"]) == saved

    # Choosing one dataset uses that dataset's name, even in a mixed queue.
    response = client.post("/api/export/archive", json={"item_ids": [items[2]["id"]]})
    assert response.status_code == 200
    assert response.headers["x-export-filename"].startswith("SeisCanvas_F3_Export_")
    assert client.get("/api/export/queue").json() == original
    assert json.loads((export_queue.session().folder / "manifest.json").read_text())["figure_count"] == 3


@pytest.mark.parametrize("selection,status", [
    ([], 422),
    (["exp_missing"], 404),
    (["exp_0001", "exp_missing"], 404),
    (["exp_0001", "exp_0001"], 400),
])
def test_archive_rejects_invalid_selection_without_exporting_other_figures(client, selection, status):
    response = client.post("/api/export/queue", json=queue_body(settings={"width": 40, "height": 30, "dpi": 300}))
    assert response.status_code == 200, response.text
    original = client.get("/api/export/queue").json()
    response = client.post("/api/export/archive", json={"item_ids": selection})
    assert response.status_code == status
    assert client.get("/api/export/queue").json() == original


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


def stored_figure(queue, **changes):
    """A frozen file is sufficient for queue lifecycle and persistence tests."""
    return queue.add(**{
        "data": b"saved figure", "filename": "Figure.png", "view_type": "2d_inline",
        "dataset": "Test", "view_state": {}, "summary": {}, **changes,
    })


def test_clear_never_reuses_figure_ids_or_paths_even_after_restart(tmp_path):
    queue = export_queue.ExportSession(tmp_path / "queue")
    first = stored_figure(queue)
    queue.clear()
    queue = export_queue.ExportSession.load(queue.folder)
    second = stored_figure(queue)
    assert second["id"] == "exp_0002"
    assert second["temporary_path"] != first["temporary_path"]
    assert not Path(first["temporary_path"]).exists()
    with pytest.raises(KeyError):
        queue.file(first["id"])


def test_archives_coexist_and_response_cleanup_preserves_other_downloads(client):
    queue = export_queue.session()
    stored_figure(queue)
    first, _, _ = queue.archive()
    second, _, _ = queue.archive()
    assert first != second
    for path in (first, second):
        with zipfile.ZipFile(path) as archive:
            assert archive.read("2D/Inline/Figure.png") == b"saved figure"
    response = client.post("/api/export/archive")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert archive.read("2D/Inline/Figure.png") == b"saved figure"
    # TestClient consumes the response and completes its background cleanup.
    assert set(queue.folder.glob("_archive_*.zip")) == {first, second}


def test_failed_archive_removes_its_partial_zip(client, monkeypatch):
    queue = export_queue.session()
    stored_figure(queue)
    def fail(*args, **kwargs):
        raise OSError("disk full")
    monkeypatch.setattr(zipfile.ZipFile, "write", fail)
    assert client.post("/api/export/archive").status_code == 400
    assert list(queue.folder.glob("_archive_*.zip")) == []
    assert queue.file("exp_0001")[0].read_bytes() == b"saved figure"


@pytest.mark.parametrize("operation", ["add", "rename", "delete", "clear"])
def test_queue_rolls_back_metadata_serialization_errors(tmp_path, monkeypatch, operation):
    queue = export_queue.ExportSession(tmp_path / "queue")
    item = stored_figure(queue)
    before = deepcopy(queue.snapshot())
    original_files = {path.name: path.read_bytes() for path in (queue.folder / export_queue.FIGURES).iterdir()}
    def fail():
        raise ValueError("Invalid JSON metadata")
    monkeypatch.setattr(queue, "_write_manifest", fail)
    with pytest.raises(ValueError, match="Invalid JSON"):
        if operation == "add":
            stored_figure(queue)
        elif operation == "rename":
            queue.rename(item["id"], "Renamed")
        elif operation == "delete":
            queue.delete(item["id"])
        else:
            queue.clear()
    assert queue.snapshot() == before
    assert queue._counter == 1
    assert queue._bytes == len(b"saved figure")
    assert {path.name: path.read_bytes() for path in (queue.folder / export_queue.FIGURES).iterdir()} == original_files


@pytest.mark.parametrize("mirror", ["queue.json.bak", "manifest.json"])
def test_failed_optional_mirror_does_not_undo_a_committed_queue(tmp_path, monkeypatch, mirror):
    queue = export_queue.ExportSession(tmp_path / "queue")
    original = export_queue.atomic_json
    def save(path, value, **options):
        if path.name == mirror:
            raise ValueError("Damaged optional metadata")
        return original(path, value, **options)
    monkeypatch.setattr(export_queue, "atomic_json", save)
    item = stored_figure(queue)
    restored = export_queue.ExportSession.load(queue.folder)
    assert restored.snapshot() == queue.snapshot()
    assert restored.file(item["id"])[0].read_bytes() == b"saved figure"


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf"), object()])
def test_queue_rejects_unserializable_state_before_writing_a_figure(tmp_path, invalid):
    queue = export_queue.ExportSession(tmp_path / "queue")
    with pytest.raises((ValueError, TypeError)):
        stored_figure(queue, view_state={"scene": {"camera": {"eye": {"x": invalid}}}})
    assert queue.snapshot()["count"] == 0
    assert list((queue.folder / export_queue.FIGURES).iterdir()) == []
    assert stored_figure(queue)["id"] == "exp_0001"


@pytest.mark.parametrize("operation", ["add", "rename"])
def test_partial_figure_write_preserves_queue_and_original_bytes(tmp_path, monkeypatch, operation):
    queue = export_queue.ExportSession(tmp_path / "queue")
    item = stored_figure(queue)
    before = deepcopy(queue.snapshot())
    write_bytes = Path.write_bytes
    def partial_write(path, data):
        write_bytes(path, b"partial")
        raise OSError("disk full")
    def partial_copy(source, target):
        partial_write(target, b"partial")
    with monkeypatch.context() as patch:
        if operation == "add":
            patch.setattr(Path, "write_bytes", partial_write)
        else:
            patch.setattr(export_queue.shutil, "copyfile", partial_copy)
        with pytest.raises(OSError, match="disk full"):
            if operation == "add":
                stored_figure(queue)
            else:
                queue.rename(item["id"], "Renamed")
    assert queue.snapshot() == before
    figures = list((queue.folder / export_queue.FIGURES).iterdir())
    assert figures == [Path(item["temporary_path"])]
    assert figures[0].read_bytes() == b"saved figure"
    assert stored_figure(queue)["id"] == "exp_0002"


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), float("-inf"), object()])
def test_scene_camera_rejects_nonfinite_or_nonjson_values(invalid):
    from backend.models import SceneState
    with pytest.raises(ValueError, match="finite JSON"):
        SceneState(camera={"eye": {"x": invalid}})


@pytest.mark.parametrize(("keys", "invalid"), [
    (("counter",), "1"), (("counter",), True),
    (("items", 0, "serial"), "1"), (("items", 0, "size_bytes"), -1),
    (("items", 0, "summary"), []), (("items", 0, "render"), None),
    (("items", 0, "width_mm"), "180"), (("items", 0, "pixel_size"), [0, 200]),
    (("items", 0, "stored"), ".."), (("items", 0, "filename"), "../figure.png"),
    (("items", 0, "format"), "unknown"), (("items", 0), None),
])
def test_damaged_queue_field_types_recover_from_backup(tmp_path, keys, invalid):
    queue = export_queue.ExportSession(tmp_path / "queue")
    stored_figure(queue)
    path = queue.folder / "queue.json"
    damaged = json.loads(path.read_text())
    field = damaged
    for key in keys[:-1]:
        field = field[key]
    field[keys[-1]] = invalid
    path.write_text(json.dumps(damaged))
    assert export_queue.ExportSession.load(queue.folder).snapshot() == queue.snapshot()
    path.with_suffix(".json.bak").unlink()
    with pytest.raises(ValueError, match="保存文件损坏"):
        export_queue.ExportSession.load(queue.folder)


def test_missing_queue_has_an_expected_error_and_inactive_figure_returns_404(client):
    document = server.project.create("Never exported")
    folder = server.project.export_folder(document)
    with pytest.raises(ValueError, match="not found"):
        export_queue.ExportSession.load(folder)
    response = client.get(f"/api/export/queue/exp_0001/file?project_id={document['id']}")
    assert response.status_code == 404
    assert not folder.exists()


@pytest.mark.parametrize("reverse_polarity", [False, True])
@pytest.mark.parametrize("clipping", [
    {"clip_mode": "percentile", "clip_percentile": 95, "symmetric": True},
    {"clip_mode": "percentile", "clip_percentile": 85, "symmetric": False},
    {"clip_mode": "manual", "vmin": -1250, "vmax": 1250},
])
def test_2d_queue_reuses_rendered_amplitudes_and_preserves_pixels_and_manifest(
    cube, horizon, monkeypatch, reverse_polarity, clipping,
):
    import numpy as np
    import backend.rendering as rendering
    from backend.export_service import add_2d
    from backend.models import Queue2DRequest

    request = Queue2DRequest.model_validate({
        "state": {"section_number": 12, "x_range": [31, 36], "time_range": [202, 210],
                  "seismic": {**clipping, "reverse_polarity": reverse_polarity},
                  "horizons": [{"id": "h", "name": "Horizon"}]},
        "settings": {"canvas": "fit", "long_edge": 600},
    })
    horizons = {"h": horizon}
    # The bytes-only public renderer remains the reference for queued pixels.
    expected = rendering.render(cube, horizons, request.state, request.settings)
    native = cube.section("inline", 12)[2]
    _, lo, hi = rendering.amplitude(native, request.state.seismic)
    section_calls, amplitude_calls, percentile_calls = [], [], []
    original_section, original_amplitude, original_percentile = cube.section, rendering.amplitude, np.percentile
    def section(*args):
        section_calls.append(args)
        return original_section(*args)
    def amplitude(*args):
        amplitude_calls.append(args[0].shape)
        return original_amplitude(*args)
    def percentile(*args, **options):
        percentile_calls.append(args[0].shape)
        return original_percentile(*args, **options)
    monkeypatch.setattr(cube, "section", section)
    monkeypatch.setattr(rendering, "amplitude", amplitude)
    monkeypatch.setattr(np, "percentile", percentile)
    item = add_2d(cube, horizons, request)
    assert section_calls == [("inline", 12)]
    assert amplitude_calls == [native.shape]
    assert len(percentile_calls) == (0 if clipping["clip_mode"] == "manual" else 1)
    with Image.open(io.BytesIO(expected)) as before, Image.open(item["temporary_path"]) as after:
        np.testing.assert_array_equal(np.asarray(after), np.asarray(before))
    figure = export_queue.session().manifest()["figures"][0]
    assert figure["colorbar_range"] == [lo, hi]
    assert figure["view_state"] == request.state.model_dump()
    for key in ("clip_mode", "clip_percentile", "symmetric", "vmin", "vmax", "reverse_polarity"):
        assert figure[key] == getattr(request.state.seismic, key)
