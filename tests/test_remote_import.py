from fastapi.testclient import TestClient
import pytest

import backend.file_picker as picker
import backend.main as server


def test_headless_detection_and_no_native_dialog(monkeypatch):
    monkeypatch.delenv("SEISCANVAS_REMOTE", raising=False)
    monkeypatch.setattr(picker.sys, "platform", "linux")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    assert picker.server_path_mode()
    with pytest.raises(ValueError, match="绝对路径"):
        picker.choose_segy()
    monkeypatch.setenv("DISPLAY", ":0")
    assert not picker.server_path_mode()
    monkeypatch.setenv("SEISCANVAS_REMOTE", "1")
    assert picker.server_path_mode()


def test_remote_import_preview_mapping_and_progress(cube, tmp_path, monkeypatch):
    monkeypatch.setenv("SEISCANVAS_REMOTE", "1")
    def fail_picker(*args, **kwargs):
        raise AssertionError("Remote imports must not open a desktop window")
    monkeypatch.setattr(server, "choose_segy", fail_picker)
    client = TestClient(server.app)
    assert client.get("/api/catalog").json()["server_path_mode"]
    response = client.post("/api/segy/pick", json={"path": str(cube.path), "job_id": "remote-test"})
    assert response.status_code == 200, response.text
    assert response.json()["metadata"]["filename"] == cube.path.name
    assert client.get("/api/segy/progress/remote-test").json()["status"] == "done"
    paths = [tmp_path / "first horizon.txt", tmp_path / "second.dat"]
    for path in paths:
        path.write_text("time inline xline\n204 10 30\n208 12 33\n")
    preview = client.post("/api/horizons/pick", json={"paths": [str(p) for p in paths]})
    assert preview.status_code == 200, preview.text
    payload = preview.json()
    assert payload["filenames"] == [p.name for p in paths]
    response = client.post("/api/horizons/local", json={
        "token": payload["token"], "inline_column": 1, "xline_column": 2,
        "time_column": 0, "model_group": "Remote", "horizon_keys": ["T1", "T2"],
    })
    assert response.status_code == 200, response.text
    assert [h["horizon_key"] for h in response.json()] == ["T1", "T2"]
    assert server.horizons[response.json()[0]["id"]].data.tolist() == [[10, 30, 204], [12, 33, 208]]
    assert client.post("/api/horizons/pick", json={"paths": ["relative.txt"]}).status_code == 400
    assert client.post("/api/horizons/pick", json={"paths": [str(tmp_path / "absent.dat")]}).status_code == 400
    assert client.post("/api/horizons/pick", json={"paths": []}).status_code == 422
    assert client.post("/api/segy/pick", json={"path": "relative.segy"}).status_code == 400
