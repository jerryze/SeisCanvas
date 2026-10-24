from copy import deepcopy

import backend.main as server
from backend.models import HorizonStyle, LocalHorizonRequest
from test_workspace import open_project, drawing_state, save, restart


def import_group(client, tmp_path, monkeypatch, model, keys):
    paths = [tmp_path / f"{model}_{index + 1}.txt" for index in range(len(keys))]
    for path in paths:
        path.write_text("10 30 204\n12 33 208\n")
    monkeypatch.setattr(server, "choose_segy", lambda *a, **kw: paths)
    selection = client.post("/api/horizons/pick").json()
    response = client.post("/api/horizons/local", json={"token": selection["token"],
        "model_group": model, "horizon_keys": keys})
    assert response.status_code == 200, response.text
    return response.json(), paths


def test_import_inherits_layer_palette_from_latest_saved_state_and_survives_restart(cube, tmp_path, monkeypatch):
    client, project = open_project(cube)
    dtw, _ = import_group(client, tmp_path, monkeypatch, "DTW", ["T24", "T25"])
    assert dtw[0]["color"] != dtw[1]["color"]
    state = drawing_state(dtw)
    state["view"]["horizons"][0]["color"] = "#123abc"
    state["view"]["horizons"][1]["color"] = "#456def"
    assert save(client, project, state).status_code == 200
    base, _ = import_group(client, tmp_path, monkeypatch, "Base", ["T25", "T24"])
    assert [h["color"] for h in base] == ["#456def", "#123abc"]
    assert [h["horizon_key"] for h in base] == ["T25", "T24"]
    assert all(h["model_group"] == "Base" for h in base)
    # Import metadata is durable even before the next browser autosave.
    restart()
    restored = client.get("/api/workspace").json()
    recovered = {h["id"]: h for h in restored["horizons"]}
    for h in base:
        assert recovered[h["id"]]["model_group"] == h["model_group"]
        assert recovered[h["id"]]["horizon_key"] == h["horizon_key"]
        assert recovered[h["id"]]["color"] == h["color"]


def test_existing_layers_can_be_organized_saved_and_renamed_without_source_changes(cube, tmp_path, monkeypatch):
    client, project = open_project(cube)
    hs, paths = import_group(client, tmp_path, monkeypatch, "Old", ["", ""])
    original = [path.read_bytes() for path in paths]
    state = drawing_state(hs)
    for h, group in zip(state["view"]["horizons"], ["Base", "Ours"]):
        h.update(model_group=group, horizon_key="T24", color="#abcdef")
    assert save(client, project, state).status_code == 200
    assert client.patch(f"/api/horizons/{hs[0]['id']}", json={"name": "Renamed"}).status_code == 200
    restart()
    restored = client.get("/api/workspace").json()["horizons"]
    assert [h["model_group"] for h in restored] == ["Base", "Ours"]
    assert all(h["horizon_key"] == "T24" and h["color"] == "#abcdef" for h in restored)
    assert restored[0]["name"] == "Renamed"
    assert [path.read_bytes() for path in paths] == original


def test_malformed_import_mapping_is_atomic_and_can_be_corrected(cube, tmp_path, monkeypatch):
    client, _ = open_project(cube)
    path = tmp_path / "one.txt"
    path.write_text("10 30 204\n12 33 208\n")
    monkeypatch.setattr(server, "choose_segy", lambda *a, **kw: [path])
    token = client.post("/api/horizons/pick").json()["token"]
    before = deepcopy(server.project.read())
    bad = client.post("/api/horizons/local", json={"token": token, "horizon_keys": ["T24", "T25"]})
    assert bad.status_code == 400
    assert server.project.read() == before and not server.horizons
    good = client.post("/api/horizons/local", json={"token": token, "model_group": " Ours ", "horizon_keys": [" T24 "]})
    assert good.status_code == 200
    assert good.json()[0]["model_group"] == "Ours" and good.json()[0]["horizon_key"] == "T24"


def test_unassigned_style_defaults_and_export_identity_fields():
    style = HorizonStyle(id="h", name="h")
    assert style.model_group == style.horizon_key == ""
    assert HorizonStyle(id="h", name="h", model_group=" Base ", horizon_key=" T24 ").horizon_key == "T24"
    assert LocalHorizonRequest(token="t").horizon_keys is None
