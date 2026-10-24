"""Settings snapshots and source checks for newly exported figures."""
from copy import deepcopy
import hashlib
import json

from backend.models import (
    ExportRestoreSnapshot, Queue2DRequest, QueueMapRequest, QueueProfileRequest,
    ViewState3D, Scene3DSettings,
)
from backend.workspace import check_source


def dependencies(kind, request):
    state = request["state"]
    styles = request.get("horizons") if kind == "profile" else state.get("horizons")
    ids = {h["id"] for h in styles or []}
    if kind in ("map", "profile"):
        ids.add(state["horizon"])
        if state.get("color_by") == "difference":
            ids.update((state.get("difference_reference"), state.get("difference_comparison")))
    return ids - {None, ""}


def source_signatures(document, ids):
    if not document or not document.get("source"):
        return None
    entries = {"survey": document["source"]}
    entries.update({f"horizon:{h['id']}": h for h in document["horizons"] if h["id"] in ids})
    result = {}
    for key, entry in entries.items():
        check_source(entry)
        # Names and display styles may change without changing scientific input.
        identity = {k: entry[k] for k in ("path", "size", "mtime_ns", "ilbyte", "xlbyte", "geometry_mode", "columns") if k in entry}
        result[key] = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    return result


def make_snapshot(req, document):
    request = req.model_dump(mode="json", exclude={
        "png", "vector_overlay", "timings", "width_px", "height_px", "scale", "render_dpi", "dataset",
    })
    if req.kind == "3d":
        request["settings"]["format"] = req.format
        request["state"]["scene"].update(export_long_edge=None, slice_viewports={})
    return ExportRestoreSnapshot(kind=req.kind, request=request,
        sources=source_signatures(document, dependencies(req.kind, request))).model_dump(mode="json")


def restore_payload(item, document, horizons):
    if item.get("restore") is None:
        raise ValueError("这张图件未保存恢复快照，请使用新增图件的恢复功能。")
    snapshot = ExportRestoreSnapshot.model_validate(item["restore"])
    request = deepcopy(snapshot.request)
    # Revalidate the stored request before returning settings to the browser.
    if snapshot.kind == "3d":
        request["state"] = ViewState3D.model_validate(request["state"]).model_dump(mode="json")
        fmt = request["settings"].get("format")
        if fmt not in ("png", "pdf", "svg"):
            raise ValueError("图件格式无效。")
        request["settings"] = {**Scene3DSettings.model_validate(request["settings"]).model_dump(mode="json"), "format": fmt}
    else:
        model = {"2d": Queue2DRequest, "map": QueueMapRequest, "profile": QueueProfileRequest}[snapshot.kind]
        request = model.model_validate(request).model_dump(mode="json")
    ids = dependencies(snapshot.kind, request)
    missing = ids - horizons.keys()
    if missing:
        raise ValueError("无法恢复：图件所需层位已移除（" + "、".join(sorted(missing)) + "）。")
    current = source_signatures(document, ids)
    if snapshot.sources is not None and snapshot.sources != current:
        raise ValueError("无法恢复：源数据或解析参数已变化，请使用与图件一致的数据。")
    warnings = [] if snapshot.sources is not None else ["该图件缺少数据来源标识，无法核对数据是否与出图时一致。"]
    return {"version": 1, "kind": snapshot.kind, "request": request, "warnings": warnings}
