"""New figure snapshots survive reload without modifying frozen image bytes."""
import base64
from copy import deepcopy
import io
from pathlib import Path

from PIL import Image
import pytest

from backend import export_queue
from backend.export_restore import make_snapshot, restore_payload
from backend.models import QueueProfileRequest, HorizonMapState
from backend.workspace import source
from test_export_routes import isolated_exports


def with_sources(fixture, cube):
    client, _, project, headers, horizons = fixture
    document = deepcopy(project.read())
    document["source"] = source(cube.path, ilbyte=189, xlbyte=21, geometry_mode="auto")
    document["horizons"] = [source(h.path, id=key, name=h.name, columns=list(h.columns), style={}) for key, h in horizons.items()]
    project.commit(document)
    return client, project, headers, horizons


def request_for(kind):
    settings = {"canvas": "fit", "long_edge": 600, "width": 180, "height": 100, "dpi": 300, "font_size": 12, "format": "png"}
    style = {"id": "isolated", "name": "H1", "color": "#123456", "model_group": "Ours", "horizon_key": "T24"}
    if kind == "2d":
        return {"kind": kind, "state": {"section_number": 12, "horizons": [style], "x_range": [30, 38], "time_range": [202, 210], "seismic": {"wiggle": True, "wiggle_gain": 2}, "horizon_sg": True}, "settings": settings}
    if kind == "map":
        return {"kind": kind, "state": {"horizon": "isolated", "interval_auto": True, "interval": 10}, "settings": settings,
                "profile": {"a": [10, 30], "b": [12, 33]}}
    if kind == "profile":
        return {"kind": kind, "state": {"horizon": "isolated"}, "a": [10, 30], "b": [12, 33], "settings": settings,
                "seismic": {"variable_area": True, "wiggle_gain": 2}, "horizons": [style], "aspect_ratio_2d": [3, 1],
                "x_range": [0, 3], "time_range": [202, 210], "show_legend": False}
    stream = io.BytesIO()
    Image.new("RGBA", (64, 64), (100, 120, 140, 255)).save(stream, format="PNG")
    return {"kind": kind, "png": "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode(),
            "format": "svg", "width_px": 64, "height_px": 64, "scale": 1, "settings": settings,
            "state": {"horizons": [style], "scene": {"camera": {"eye": {"x": 2, "y": -1, "z": 1}}},
                      "slices": {"inline": [{"id": "slice-1", "position": 12}]}}}


@pytest.mark.parametrize("kind", ["2d", "3d", "map", "profile"])
def test_restore_roundtrip_and_reexport_keep_frozen_original(isolated_exports, cube, kind):
    client, project, headers, horizons = with_sources(isolated_exports, cube)
    body = request_for(kind)
    response = client.post("/api/export/queue", headers=headers, json=body)
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["restorable"] and "restore" not in item
    original = Path(item["temporary_path"]).read_bytes()
    before = (project.export_folder() / "queue.json").read_bytes()
    restored = client.get(f"/api/export/queue/{item['id']}/settings", headers=headers)
    assert restored.status_code == 200, restored.text
    payload = restored.json()
    if kind != "map":
        styles = payload["request"]["horizons"] if kind == "profile" else payload["request"]["state"]["horizons"]
        assert styles[0]["model_group"] == "Ours" and styles[0]["horizon_key"] == "T24"
    assert payload["kind"] == kind and payload["warnings"] == []
    assert payload["request"]["settings"]["height"] == 100  # original request, not cropped image height
    assert "png" not in payload["request"] and "vector_overlay" not in payload["request"]
    assert (project.export_folder() / "queue.json").read_bytes() == before
    loaded = export_queue.ExportSession.load(project.export_folder())
    assert restore_payload(loaded.restore_item(item["id"]), project.read(), horizons) == payload
    if kind == "map":
        assert payload["request"]["state"]["interval"] is None
        assert payload["request"]["profile"]["a"] == [10, 30]
    if kind == "profile":
        assert payload["request"]["seismic"]["variable_area"]
        assert payload["request"]["aspect_ratio_2d"] == [3, 1]
        assert payload["request"]["show_legend"] is False
    if kind == "3d":
        assert payload["request"]["settings"]["format"] == "svg"
        assert payload["request"]["state"]["scene"]["camera"] == body["state"]["scene"]["camera"]
    repeat = {**body, **payload["request"]}
    another = client.post("/api/export/queue", headers=headers, json=repeat)
    assert another.status_code == 200, another.text
    assert another.json()["id"] != item["id"]
    assert Path(item["temporary_path"]).read_bytes() == original


def test_missing_layer_and_changed_source_block_before_applying(isolated_exports, cube):
    client, project, headers, horizons = with_sources(isolated_exports, cube)
    item = client.post("/api/export/queue", headers=headers, json=request_for("2d")).json()
    url = f"/api/export/queue/{item['id']}/settings"
    layer = horizons.pop("isolated")
    response = client.get(url, headers=headers)
    assert response.status_code == 400 and "层位已移除" in response.json()["detail"]
    horizons["isolated"] = layer
    document = deepcopy(project.read())
    document["horizons"][0]["name"] = "Renamed"
    document["horizons"][0]["style"] = {"visible": False}
    project.commit(document)
    assert client.get(url, headers=headers).status_code == 200
    document["source"]["xlbyte"] = 193
    project.commit(document)
    response = client.get(url, headers=headers)
    assert response.status_code == 400 and "解析参数已变化" in response.json()["detail"]
    document["source"]["xlbyte"] = 21
    project.commit(document)
    layer.path.write_text(layer.path.read_text() + "\n")
    response = client.get(url, headers=headers)
    assert response.status_code == 400 and "数据文件已发生变化" in response.json()["detail"]


def test_snapshot_route_is_scoped_and_old_items_have_no_restore(isolated_exports, cube):
    client, project, headers, _ = with_sources(isolated_exports, cube)
    item = client.post("/api/export/queue", headers=headers, json=request_for("2d")).json()
    url = f"/api/export/queue/{item['id']}/settings"
    assert client.get(url, headers={**headers, "X-SeisCanvas-Epoch": "old"}).status_code == 409
    assert client.get("/api/export/queue/missing/settings", headers=headers).status_code == 404
    queue = export_queue.session()
    queue.restore_item(item["id"]).pop("restore")
    assert not queue.public(queue.restore_item(item["id"]))["restorable"]
    assert client.get(url, headers=headers).status_code == 400
    project.activate(project.create("Other project"))
    assert client.get(url, headers=headers).status_code == 409
    fresh = {**headers, "X-SeisCanvas-Project": project.read()["id"], "X-SeisCanvas-Epoch": project.epoch}
    assert client.get(url, headers=fresh).status_code == 404


def test_snapshot_detached_and_auto_contours_normalized():
    req = QueueProfileRequest.model_validate(request_for("profile"))
    snapshot = make_snapshot(req, None)
    req.a = (12, 38)
    assert snapshot["request"]["a"] == [10, 30]
    assert HorizonMapState(horizon="h", interval_auto=True, interval=10).interval is None
    assert HorizonMapState(horizon="h", interval_auto=False, interval=10).interval == 10
    with pytest.raises(ValueError):
        restore_payload({"restore": {**snapshot, "version": 9}}, None, {"isolated": object()})
