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


def requires_seismic(request):
    """Only explicit amplitude colouring requires a seismic volume."""
    if request["kind"] == "map":
        return request["state"].get("color_by", "twt") == "amplitude"
    if request["kind"] == "3d":
        return any(h.get("visible", True) and h.get("display_mode", "full_surface") == "full_surface"
                   and h.get("color_by", "twt") == "amplitude" for h in request["state"].get("horizons", []))
    return False


def uses_seismic(request, document):
    """Record real seismic backgrounds and survey-clipped A–B geometry."""
    return bool(document and document.get("source")) and (
        request["kind"] != "map" or requires_seismic(request) or request.get("profile") is not None)


def figure_dependencies(request, document):
    ids = dependencies(request["kind"], request)
    # A horizon-only scene's bounds are derived from all imported picks, even
    # when some layers are hidden. Freeze those geometry inputs as well.
    geometry_only = not (document or {}).get("source") and (
        request["kind"] != "map" or request.get("profile") is not None)
    if geometry_only or (request["kind"] == "profile" and request.get("horizons") is None):
        ids.update(h["id"] for h in (document or {}).get("horizons", []))
    return ids


def source_signatures(document, ids, *, include_survey=True):
    """Fingerprint only the scientific sources used by this figure."""
    if not document:
        return None
    entries = {"survey": document["source"]} if include_survey and document.get("source") else {}
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
        sources=source_signatures(document, figure_dependencies(request, document),
                                  include_survey=uses_seismic(request, document))).model_dump(mode="json")


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
    ids = figure_dependencies(request, document)
    missing = ids - horizons.keys()
    if missing:
        raise ValueError("无法恢复：图件所需层位已移除（" + "、".join(sorted(missing)) + "）。")
    if requires_seismic(request) and not (document or {}).get("source"):
        raise ValueError("此图件需要已导入的 SEG-Y 数据。")
    current = source_signatures(document, ids, include_survey=uses_seismic(request, document))
    if snapshot.sources is not None and snapshot.sources != current:
        raise ValueError("无法恢复：源数据或解析参数已变化，请使用与图件一致的数据。")
    warnings = [] if snapshot.sources is not None else ["该图件缺少数据来源标识，无法核对数据是否与出图时一致。"]
    return {"version": 1, "kind": snapshot.kind, "request": request, "warnings": warnings}
