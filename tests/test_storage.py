"""Recovery must retain a usable backup even when damaged JSON still parses."""
import json

import pytest

from backend.storage import atomic_json, read_json
from backend.workspace import WorkspaceStore, validate_document


def test_schema_damaged_primary_cannot_overwrite_valid_backup(tmp_path, monkeypatch):
    store = WorkspaceStore(tmp_path)
    original = store.create("Original")
    store.activate(original)
    store.commit({**original, "name": "Second"})
    path = store.path
    backup = path.with_suffix(".json.bak")
    previous_backup = backup.read_bytes()
    path.write_text(json.dumps({**original, "horizons": "damaged"}))
    recovered = WorkspaceStore(tmp_path)
    assert recovered.read()["name"] == "Original"

    replace = __import__("os").replace

    def fail_primary(source, destination):
        if destination == path:
            raise OSError("disk full")
        return replace(source, destination)

    monkeypatch.setattr("backend.storage.os.replace", fail_primary)
    with pytest.raises(OSError, match="disk full"):
        recovered.commit({**recovered.read(), "name": "Recovered"})
    assert backup.read_bytes() == previous_backup
    assert read_json(path, validate_document)["name"] == "Original"
    assert recovered.read()["name"] == "Original"

    monkeypatch.setattr("backend.storage.os.replace", replace)
    recovered.commit({**recovered.read(), "name": "Recovered"})
    assert read_json(path, validate_document)["name"] == "Recovered"
    assert backup.read_bytes() == previous_backup


def test_atomic_json_validates_new_value_before_touching_saved_files(tmp_path):
    def validate(value):
        if not isinstance(value["items"], list):
            raise ValueError("invalid items")
        return value

    path = tmp_path / "items.json"
    atomic_json(path, {"items": [1]}, validate=validate)
    atomic_json(path, {"items": [2]}, validate=validate)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    with pytest.raises(ValueError, match="invalid items"):
        atomic_json(path, {"items": None}, validate=validate)
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


@pytest.mark.parametrize("damaged", [
    {"active_id": "broken"}, {"active_id": True},
    {"recent": ["broken"]}, {"recent": [None]},
])
def test_index_schema_damage_recovers_without_replacing_valid_backup(tmp_path, monkeypatch, damaged):
    store = WorkspaceStore(tmp_path)
    original = store.create("Original")
    store.activate(original)
    store.activate(original)
    path = tmp_path / "projects.json"
    backup = path.with_suffix(".json.bak")
    valid_backup = backup.read_bytes()
    index = json.loads(path.read_bytes())
    path.write_text(json.dumps({**index, **damaged}))
    recovered = WorkspaceStore(tmp_path)
    assert recovered.read()["id"] == original["id"]

    def fail_replace(*args):
        raise OSError("disk full")

    monkeypatch.setattr("backend.storage.os.replace", fail_replace)
    with pytest.raises(OSError, match="disk full"):
        recovered.activate(original)
    assert backup.read_bytes() == valid_backup
    assert WorkspaceStore(tmp_path).read()["id"] == original["id"]
