"""The last working project: source identities, stable horizons and UI state."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from backend.storage import atomic_json, read_json, state_dir


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def source(path, **parameters):
    path = Path(path).resolve()
    stat = path.stat()
    return {"path": str(path), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, **parameters}


def check_source(item):
    path = Path(item["path"])
    if not path.is_file():
        raise ValueError(f"找不到数据文件：{path}")
    stat = path.stat()
    if stat.st_size != item["size"] or stat.st_mtime_ns != item["mtime_ns"]:
        raise ValueError(f"数据文件已发生变化，请重新选择确认：{path}")
    return path


def validate_document(value):
    if value["version"] != 1 or not isinstance(value["id"], str):
        raise ValueError("不支持的项目版本")
    if not isinstance(value["source"], dict) or not isinstance(value["horizons"], list):
        raise ValueError("无效的项目数据")
    int(value["revision"])
    return value


class WorkspaceStore:
    def __init__(self, root=None):
        self.root = Path(root) if root is not None else state_dir()
        self.path = self.root / "workspace.json"
        self.document = None
        self.loaded = False

    def read(self):
        if not self.loaded:
            self.document = read_json(self.path, validate_document)
            self.loaded = True
        return self.document

    def commit(self, document):
        document = deepcopy(document)
        document["updated_at"] = timestamp()
        atomic_json(self.path, document)
        self.document = document
        self.loaded = True
        return document

    def new(self, survey_source, horizons):
        return self.commit({
            "version": 1, "id": uuid4().hex, "revision": 0,
            "source": survey_source, "horizons": horizons, "state": None,
        })

    def update_horizons(self, entries):
        document = self.read()
        if document is None:
            return
        document = deepcopy(document)
        document["horizons"] = entries
        # Keep the last saved styles in step even before the browser saves.
        if document["state"]:
            saved = {h["id"]: h for h in document["state"]["view"]["horizons"]}
            document["state"]["view"]["horizons"] = [
                {**saved.get(h["id"], h["style"]), "name": h["name"]}
                for h in entries
            ]
        self.commit(document)

    def save_state(self, project_id, revision, state):
        document = self.read()
        if document is None or document["id"] != project_id:
            raise ValueError("当前数据集已切换，请刷新页面后继续。")
        if revision != document["revision"]:
            raise ValueError("项目已在另一个页面更新，请刷新页面后继续。")
        document = deepcopy(document)
        # Source registry is authoritative; delayed saves cannot resurrect a
        # deleted horizon or replace a just-renamed source's display name.
        styles = {h["id"]: h for h in state["view"]["horizons"]}
        state = deepcopy(state)
        state["view"]["horizons"] = [
            {**styles.get(h["id"], h["style"]), "name": h["name"]}
            for h in document["horizons"]
        ]
        document["state"] = state
        document["revision"] += 1
        return self.commit(document)

    def asset_folder(self):
        folder = self.root / "imports" / uuid4().hex
        folder.mkdir(parents=True, exist_ok=True)
        return folder
