"""Export HTTP adapters keep injected state and project-scoped responses."""
import asyncio
import io
from pathlib import Path
from threading import RLock
import zipfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend import export_queue, project_scope
from backend.api.exports import ArchiveResponse, ExportContext, create_export_router
from backend.models import Settings, ViewState
from backend.rendering import render
from backend.workspace import WorkspaceStore


@pytest.fixture
def isolated_exports(cube, horizon, tmp_path, monkeypatch):
    project = WorkspaceStore(tmp_path / "isolated")
    document = project.activate(project.create("Isolated export project"))
    lock = RLock()
    monkeypatch.setattr(project_scope, "store", lambda: project)
    monkeypatch.setattr(project_scope, "lock", lock)
    horizons = {"isolated": horizon}
    application = FastAPI()
    router = create_export_router(ExportContext(
        require_survey=lambda: cube, get_horizons=lambda: horizons,
        get_project=lambda: project, project_lock=lock,
    ))
    application.include_router(router)
    headers = {"X-SeisCanvas-Project": document["id"], "X-SeisCanvas-Epoch": project.epoch,
               "X-SeisCanvas-Revision": str(document["revision"])}
    return TestClient(application), router, project, headers, horizons


def test_injected_export_state_preserves_response_bytes_and_download_ownership(isolated_exports, cube):
    client, router, project, headers, horizons = isolated_exports
    assert all(isinstance(route, project_scope.ProjectRoute) for route in router.routes)
    state = ViewState(section_number=12, horizons=[{"id": "isolated", "name": "Injected"}])
    settings = Settings(canvas="fit", long_edge=600)
    expected = render(cube, horizons, state, settings)
    request = {"state": state.model_dump(), "settings": settings.model_dump()}
    response = client.post("/api/export", headers=headers, json=request)
    assert response.status_code == 200
    assert response.content == expected
    assert response.headers["content-type"] == "image/png"
    assert response.headers["content-disposition"] == 'attachment; filename="SeisCanvas_inline_12.png"'
    assert response.headers["x-project-revision"] == "0"

    item = client.post("/api/export/queue", headers=headers, json={"kind": "2d", **request}).json()
    assert Path(item["temporary_path"]).is_relative_to(project.export_folder())
    preview = client.get(f"/api/export/queue/{item['id']}/file?project_id={project.read()['id']}")
    assert preview.status_code == 200 and preview.content == expected
    missing_owner = client.send(client.build_request("GET", f"/api/export/queue/{item['id']}/file"))
    assert missing_owner.status_code == 428
    assert client.get(f"/api/export/queue/missing/file?project_id={project.read()['id']}").status_code == 404

    renamed = client.patch(f"/api/export/queue/{item['id']}", headers=headers, json={"filename": "Retained"})
    assert renamed.status_code == 200 and renamed.json()["filename"] == "Retained.png"
    archived = client.post("/api/export/archive", headers=headers)
    assert archived.status_code == 200
    assert archived.headers["x-export-figures"] == "1"
    with zipfile.ZipFile(io.BytesIO(archived.content)) as archive:
        assert archive.read("2D/Inline/Retained.png") == expected
    assert list(project.export_folder().glob("_archive_*.zip")) == []
    assert client.delete(f"/api/export/queue/{item['id']}", headers=headers).json() == {"ok": True}
    assert client.get("/api/export/queue", headers=headers).json()["count"] == 0
    assert client.delete("/api/export/queue", headers=headers).json() == {"ok": True}


def test_extracted_routes_still_require_current_project_and_mutation_revision(isolated_exports):
    client, _, project, headers, _ = isolated_exports
    body = {"kind": "2d", "state": {"section_number": 12}, "settings": {"long_edge": 600}}
    missing = client.send(client.build_request("POST", "/api/export/queue", json=body))
    assert missing.status_code == 428
    assert missing.json()["detail"]["code"] == "PROJECT_REQUIRED"
    without_revision = {key: value for key, value in headers.items() if key != "X-SeisCanvas-Revision"}
    missing_revision = client.send(client.build_request("POST", "/api/export/queue", headers=without_revision, json=body))
    assert missing_revision.status_code == 428
    assert missing_revision.json()["detail"]["code"] == "REVISION_REQUIRED"
    stale = client.post("/api/export", headers={**headers, "X-SeisCanvas-Epoch": "expired"}, json=body)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "PROJECT_CHANGED"
    assert not project.export_folder().exists()


def test_export_fonts_remain_public_and_missing_resources_keep_status_codes(isolated_exports):
    client, _, _, headers, _ = isolated_exports
    font = client.send(client.build_request("GET", "/api/fonts/sans"))
    assert font.status_code == 200 and font.headers["content-type"] == "font/ttf"
    assert font.content.startswith(b"\x00\x01\x00\x00")
    assert client.get("/api/fonts/missing").status_code == 404
    response = client.post("/api/horizon-map/export", headers=headers,
                           json={"state": {"horizon": "missing"}, "settings": {"long_edge": 600}})
    assert response.status_code == 404
    invalid = client.post("/api/export/3d", headers=headers, json={
        "png": "invalid", "format": "png", "width": 64, "height": 64, "scale": 1,
    })
    assert invalid.status_code == 400 and invalid.json()["detail"] == "Expected a PNG rendering."


@pytest.mark.parametrize("failure", [OSError, asyncio.CancelledError])
def test_archive_response_cleans_only_its_zip_when_body_send_is_interrupted(isolated_exports, failure):
    _, router, project, _, _ = isolated_exports
    with project_scope.guarded_lock():
        queue = export_queue.session()
        queue.add(data=b"frozen figure", filename="Figure.png", view_type="2d_inline",
                  dataset="Test", view_state={}, summary={})
    other, _, _ = queue.archive()
    endpoint = next(route.endpoint for route in router.routes if route.path == "/api/export/archive")
    response = endpoint()
    assert isinstance(response, ArchiveResponse)
    path = Path(response.path)
    sent = []
    async def send(message):
        sent.append(message["type"])
        if message["type"] == "http.response.body":
            raise failure("download interrupted")
    async def receive():
        return {"type": "http.disconnect"}
    with pytest.raises(failure):
        asyncio.run(response({"type": "http", "method": "GET", "headers": []}, receive, send))
    assert sent == ["http.response.start", "http.response.body"]
    assert not path.exists()
    assert other.exists()


@pytest.mark.parametrize("fmt", ["png", "pdf", "svg"])
def test_map_name_preview_and_custom_name_match_saved_figure(isolated_exports, fmt):
    client, router, project, headers, _ = isolated_exports
    body = {"kind": "map", "state": {"horizon": "isolated"},
            "settings": {"canvas": "fit", "long_edge": 600, "format": fmt}}
    read_headers = {k: v for k, v in headers.items() if k != "X-SeisCanvas-Revision"}
    preview = client.post("/api/export/map-name", headers=read_headers, json=body)
    assert preview.status_code == 200, preview.text
    assert preview.json()["filename"] == f"层位图_{isolated_exports[-1]['isolated'].name}.{fmt}"
    assert client.get("/api/export/queue", headers=headers).json()["count"] == 0
    # Dots in stems and dimension-looking text must not be rewritten after render.
    body["filename"] = "T24.v2_180x100mm_300dpi.png"
    preview = client.post("/api/export/map-name", headers=headers, json=body).json()["filename"]
    assert preview == f"T24.v2_180x100mm_300dpi.{fmt}"
    saved = client.post("/api/export/queue", headers=headers, json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["filename"] == preview
    assert max(saved.json()["pixel_size"]) == 600
    next_name = client.post("/api/export/map-name", headers=headers, json=body).json()["filename"]
    assert next_name == f"T24.v2_180x100mm_300dpi_02.{fmt}"


def test_map_name_rejects_blank_and_sanitizes_paths(isolated_exports):
    client, _, _, headers, _ = isolated_exports
    body = {"kind": "map", "state": {"horizon": "isolated"}, "settings": {"format": "svg"}, "filename": "  "}
    assert client.post("/api/export/map-name", headers=headers, json=body).status_code == 422
    body["filename"] = "../测试:地图.png"
    name = client.post("/api/export/map-name", headers=headers, json=body).json()["filename"]
    assert name == "测试-地图.svg"
