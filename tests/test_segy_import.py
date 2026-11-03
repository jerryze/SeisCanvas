"""SEG-Y imports are validated by content, independently of the filename."""
from copy import deepcopy
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

import backend.file_picker as picker
import backend.main as server


def import_file(client, path, entry, monkeypatch):
    if entry == "upload":
        return client.post("/api/segy", files={"file": (path.name, path.read_bytes())})
    if entry == "native":
        monkeypatch.setattr(server, "choose_segy", lambda: str(path))
        return client.post("/api/segy/pick", json={})
    return client.post(f"/api/segy/{entry}", json={"path": str(path)})


@pytest.mark.parametrize("entry", ["local", "pick", "native", "upload"])
@pytest.mark.parametrize("filename", ["survey.dat", "survey.sgy.backup", "survey"])
def test_valid_content_with_any_filename(cube, tmp_path, monkeypatch, entry, filename):
    path = tmp_path / filename
    path.write_bytes(cube.path.read_bytes())
    response = import_file(TestClient(server.app), path, entry, monkeypatch)
    assert response.status_code == 200, response.text
    assert response.json()["metadata"]["filename"] == filename
    for actual, expected in zip(server.survey.section("inline", 10), cube.section("inline", 10)):
        np.testing.assert_array_equal(actual, expected)


@pytest.mark.parametrize("entry", ["local", "pick", "native", "upload"])
def test_invalid_content_preserves_current_project(cube, tmp_path, monkeypatch, entry):
    client = TestClient(server.app)
    assert client.post("/api/segy/local", json={"path": str(cube.path)}).status_code == 200
    before = deepcopy(server.project.read())
    survey, epoch = server.survey, server.project.epoch
    assets = {p for p in server.project.root.rglob("*") if p.is_file()}
    invalid = tmp_path / "not-seismic.dat"
    invalid.write_bytes(b"not a SEG-Y file")
    response = import_file(client, invalid, entry, monkeypatch)
    assert response.status_code == 400
    assert response.json()["detail"]
    assert server.survey is survey and server.project.epoch == epoch
    assert server.project.read() == before
    assert {p for p in server.project.root.rglob("*") if p.is_file()} == assets


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
@pytest.mark.parametrize("kind,multiple", [("SEG-Y", False), ("Horizon", True)])
def test_native_picker_accepts_all_files(monkeypatch, platform, kind, multiple):
    monkeypatch.setattr(picker, "server_path_mode", lambda: False)
    monkeypatch.setattr(picker.sys, "platform", platform)
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(returncode=0, stdout="/data/survey\n")
    monkeypatch.setattr(picker.subprocess, "run", run)
    assert picker.choose_segy(kind, multiple) == (["/data/survey"] if multiple else "/data/survey")
    script = commands[0][-1]
    assert "*.sgy" not in script and "*.segy" not in script
    if platform == "linux":
        compile(script, "picker", "exec")
        assert 'filetypes=[("All files", "*")]' in script
    elif platform == "win32":
        assert "$dialog.Filter = 'All files (*.*)|*.*'" in script
