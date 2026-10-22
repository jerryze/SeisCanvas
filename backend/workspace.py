"""Small, independent project documents; original scientific files stay in place."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import re
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


def project_name(value):
    value = value.strip()
    if not value or len(value) > 80 or any(ord(c) < 32 for c in value):
        raise ValueError("项目名称应为 1–80 个字符，且不能包含控制字符。")
    return value


def validate_document(value):
    if value["version"] != 1 or not re.fullmatch(r"[a-f0-9]{32}", value["id"]):
        raise ValueError("不支持的项目版本")
    if value.get("schema_version", 2) != 2:
        raise ValueError("不支持的项目格式版本")
    if value["source"] is not None and not isinstance(value["source"], dict):
        raise ValueError("无效的数据来源")
    if not isinstance(value["horizons"], list):
        raise ValueError("无效的项目数据")
    if not isinstance(value["revision"], int) or value["revision"] < 0:
        raise ValueError("无效的项目版本号")
    datetime.fromisoformat(value["updated_at"])
    for item in [value["source"], *value["horizons"]]:
        if item is not None:
            if not isinstance(item["path"], str) or not isinstance(item["size"], int) or not isinstance(item["mtime_ns"], int):
                raise ValueError("无效的数据文件引用")
    if value["source"]:
        item = value["source"]
        if not 1 <= item["ilbyte"] <= 237 or not 1 <= item["xlbyte"] <= 237 or item["geometry_mode"] not in ("auto", "regular"):
            raise ValueError("无效的地震体解析参数")
    for item in value["horizons"]:
        if not isinstance(item["id"], str) or not isinstance(item["name"], str) or not isinstance(item["style"], dict) or len(item["columns"]) != 3:
            raise ValueError("无效的层位数据")
    if value.get("state") is not None:
        state = value["state"]
        if state["version"] != 1 or not isinstance(state["view"]["horizons"], list):
            raise ValueError("无效的项目工作状态")
    if value.get("name") is not None:
        if not isinstance(value["name"], str):
            raise ValueError("无效的项目名称")
        project_name(value["name"])
    return value


def validate_index(value):
    if value["version"] != 2 or not isinstance(value["recent"], list):
        raise ValueError("无效的项目索引")
    active_id = value.get("active_id")
    ids = value["recent"] + ([active_id] if active_id is not None else [])
    if any(not isinstance(project_id, str) or not re.fullmatch(r"[a-f0-9]{32}", project_id)
           for project_id in ids):
        raise ValueError("无效的项目索引 ID")
    return value


class WorkspaceStore:
    """Project files are authoritative; projects.json is a recoverable index."""
    def __init__(self, root=None):
        self.root = Path(root) if root is not None else state_dir()
        self.path = self.root / "workspace.json"  # updated after first read/activation
        self.document = None
        self.loaded = False
        self.epoch = uuid4().hex
        self.pending = {}

    def project_path(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r"[a-f0-9]{32}", project_id):
            raise ValueError("无效的项目 ID")
        return self.root / "projects" / project_id / "project.json"

    def _index(self):
        try:
            return read_json(self.root / "projects.json", validate_index) or {"version": 2, "active_id": None, "recent": []}
        except ValueError:
            # Rebuild summaries from the documents; never overwrite them.
            return {"version": 2, "active_id": None, "recent": []}

    def _migrate(self):
        legacy = self.root / "workspace.json"
        if (self.root / "projects.json").exists() or not (legacy.exists() or legacy.with_suffix(".json.bak").exists()):
            return
        old = read_json(legacy, validate_document)
        target = self.project_path(old["id"])
        if not target.exists():
            old = deepcopy(old)
            old.update(schema_version=2, name=Path(old["source"]["path"]).stem[:80] or "恢复的项目",
                       created_at=old.get("updated_at", timestamp()))
            queues = sorted((self.root / "exports").glob("session_*"), key=lambda p: p.stat().st_mtime, reverse=True)
            for folder in queues:
                if (folder / "queue.json").exists() or (folder / "queue.json.bak").exists():
                    old["legacy_exports"] = str(folder)
                    break
            atomic_json(target, old, validate=validate_document)
        atomic_json(self.root / "projects.json", {"version": 2, "active_id": old["id"], "recent": [old["id"]]}, validate=validate_index)

    def read(self):
        if not self.loaded:
            # Report a damaged legacy/active file once, then allow the user to
            # choose another project or explicitly create one. Never replace
            # the damaged document with defaults during that recovery.
            self.loaded = True
            self._migrate()
            active_id = self._index().get("active_id")
            if active_id:
                self.path = self.project_path(active_id)
                self.loaded = True
                self.document = read_json(self.path, validate_document)
            self.loaded = True
        return self.document

    def get(self, project_id):
        if self.read() is not None and self.document["id"] == project_id:
            return deepcopy(self.document)
        document = read_json(self.project_path(project_id), validate_document)
        if document is None:
            raise ValueError("找不到该项目")
        return document

    def list(self):
        self.read()
        index = self._index()
        result = []
        for path in (self.root / "projects").glob("*/project.json"):
            try:
                d = read_json(path, validate_document)
                item = d.get("source")
                files = [item, *d["horizons"]] if item else d["horizons"]
                missing = any(not Path(f["path"]).is_file() for f in files)
                result.append({"id": d["id"], "name": d.get("name", "恢复的项目"), "revision": d["revision"],
                               "updated_at": d["updated_at"], "filename": Path(item["path"]).name if item else None,
                               "path": item["path"] if item else None, "horizon_count": len(d["horizons"]),
                               "status": "missing" if missing else "unchecked" if item else "empty"})
            except (ValueError, OSError, KeyError, TypeError):
                result.append({"id": path.parent.name, "name": "损坏的项目", "status": "damaged", "updated_at": ""})
        recent = index.get("recent", [])
        result.sort(key=lambda d: (recent.index(d["id"]) if d["id"] in recent else len(recent), -_date_order(d["updated_at"])))
        return {"active_id": self.document["id"] if self.document else None, "projects": result}

    def activate(self, document):
        index = self._index()
        recent = [document["id"], *[p for p in index["recent"] if p != document["id"]]]
        atomic_json(self.root / "projects.json", {"version": 2, "active_id": document["id"], "recent": recent}, validate=validate_index)
        self.path = self.project_path(document["id"])
        self.document, self.loaded = deepcopy(document), True
        self.epoch = uuid4().hex
        self.pending.clear()
        return self.document

    def write(self, document):
        document = deepcopy(document)
        document["updated_at"] = timestamp()
        validate_document(document)
        atomic_json(self.project_path(document["id"]), document, validate=validate_document)
        return document

    def commit(self, document):
        document = self.write(document)
        self.document, self.loaded = document, True
        self.path = self.project_path(document["id"])
        return document

    def create(self, name, *, request_id=None, template=None):
        # A deterministic ID makes retrying a lost create response harmless.
        project_id = request_id or uuid4().hex
        path = self.project_path(project_id)
        if path.exists():
            return self.get(project_id)
        document = deepcopy(template) if template else {"source": None, "horizons": [], "state": None}
        document.pop("legacy_exports", None)
        document.update(version=1, schema_version=2, id=project_id, name=project_name(name), revision=0,
                        created_at=timestamp())
        return self.write(document)

    def new(self, survey_source, horizons):
        current = self.read()
        if current and current["source"] is None:
            document = deepcopy(current)
            document.update(source=survey_source, horizons=horizons, state=None, revision=current["revision"] + 1)
            result = self.commit(document)
            self.epoch = uuid4().hex
            self.pending.clear()
            return result
        document = self.create(Path(survey_source["path"]).stem[:80] or "未命名项目",
                               template={"source": survey_source, "horizons": horizons, "state": None})
        return self.activate(document)

    def update_horizons(self, entries):
        document = self.read()
        if document is None:
            return
        document = deepcopy(document)
        document["horizons"] = entries
        if document["state"]:
            saved = {h["id"]: h for h in document["state"]["view"]["horizons"]}
            document["state"]["view"]["horizons"] = [
                {**saved.get(h["id"], h["style"]), "name": h["name"]} for h in entries
            ]
        document["revision"] += 1
        return self.commit(document)

    def save_state(self, project_id, revision, state):
        document = self.read()
        if document is None or document["id"] != project_id:
            raise ValueError("当前项目已切换，请刷新页面后继续。")
        if revision != document["revision"]:
            raise ValueError("项目已在另一个页面更新，请刷新页面后继续。")
        document = deepcopy(document)
        styles = {h["id"]: h for h in state["view"]["horizons"]}
        state = deepcopy(state)
        state["view"]["horizons"] = [
            {**styles.get(h["id"], h["style"]), "name": h["name"]} for h in document["horizons"]
        ]
        document["state"] = state
        document["revision"] += 1
        return self.commit(document)

    def export_folder(self, document=None):
        document = document or self.read()
        if not document:
            return None
        if document.get("legacy_exports"):
            return Path(document["legacy_exports"])
        return self.project_path(document["id"]).parent / "exports"

    def asset_folder(self):
        folder = self.root / "assets" / uuid4().hex
        folder.mkdir(parents=True, exist_ok=True)
        return folder


def _date_order(value):
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return 0
