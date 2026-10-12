"""The standalone server must serve the same favicon files as Vite."""

import pytest
from fastapi.testclient import TestClient

from backend import main as server


@pytest.mark.skipif(not server.DIST.exists(), reason="Frontend build is unavailable")
@pytest.mark.parametrize("name,mime", [
    ("favicon.svg", "image/svg+xml"),
    ("favicon-16.png", "image/png"),
    ("favicon-32.png", "image/png"),
    ("favicon.ico", "image/"),
])
def test_standalone_favicon_is_served_from_built_public_files(name, mime):
    with TestClient(server.app) as client:
        response = client.get(f"/{name}?v=3")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith(mime)
        assert response.content == (server.DIST / name).read_bytes()


@pytest.mark.skipif(not server.DIST.exists(), reason="Frontend build is unavailable")
def test_static_mount_preserves_homepage_and_api_routing():
    with TestClient(server.app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.content == (server.DIST / "index.html").read_bytes()
        assert client.get("/api/export/queue").status_code == 200
        assert client.get("/nonexistent-favicon.png").status_code == 404
