"""Physical-coordinate 3D slice and horizon geometry. No renderer coordinates here."""

from collections import OrderedDict
import numpy as np
import segyio
from backend.rendering import amplitude


#: Above this many samples a slice is never read at native resolution; the
#: renderer reads a bounded supersample instead (4 million float32, ~16 MB).
SLICE_NATIVE_BUDGET = 4_000_000
#: Upper bound for the supersampled preview read used when downsampling.
SLICE_SUPERSAMPLE_BUDGET = 1_000_000


def indices(length, maximum):
    """Endpoint-preserving preview sampling; coordinates are never renumbered."""
    return np.unique(np.linspace(0, length - 1, min(length, maximum), dtype=int))


def serial(array):
    values = np.asarray(array)
    return np.where(np.isfinite(values), values, None).tolist()


def timeslice(survey, time):
    if not survey.times[0] <= time <= survey.times[-1]:
        raise ValueError("Time slice is outside the survey time range.")
    index = int(np.argmin(np.abs(survey.times - time)))
    actual = float(survey.times[index])
    key = ("time", index)
    if key in survey.cache:
        survey.cache.move_to_end(key)
        return actual, survey.cache[key]
    # Unstructured depth_slice returns one sample per trace, in file order.
    with segyio.open(str(survey.path), ignore_geometry=True) as f:
        values = np.asarray(f.depth_slice[index]).reshape(-1)
    grid = np.full(
        (len(survey.inlines), len(survey.crosslines)), np.nan, dtype=np.float32
    )
    if survey.regular is not None:
        grid = survey.regular.timeslice_grid(values).copy()
    elif survey.trace_lookup is not None:
        valid = survey.trace_lookup >= 0
        grid[valid] = values[survey.trace_lookup[valid]]
    else:
        grid[
            np.searchsorted(survey.inlines, survey.ils),
            np.searchsorted(survey.crosslines, survey.xls),
        ] = values
    survey.cache[key] = grid
    while len(survey.cache) > 12:
        survey.cache.popitem(last=False)
    return actual, grid


def slice_data(survey, kind, position, maximum=256, interpolation="bilinear"):
    from backend.preview import read_samples, preview_ids
    from backend import resample
    if kind not in ("time", "inline", "crossline"):
        raise ValueError("Unknown slice kind.")
    if kind == "time":
        if not survey.times[0] <= position <= survey.times[-1]:
            raise ValueError("Time slice is outside the survey time range.")
        sample = int(np.argmin(np.abs(survey.times-position)))
        actual = float(survey.times[sample])
        a, b = survey.crosslines, survey.inlines
    else:
        axis = survey.inlines if kind == "inline" else survey.crosslines
        if position != int(position) or position not in axis:
            raise ValueError("Section does not exist in this survey.")
        actual = int(position)
        a = survey.crosslines if kind == "inline" else survey.inlines
        b = survey.times
    # Texture grid: bounded by the requested maximum and by the real samples.
    cols, rows = indices(len(a), maximum), indices(len(b), maximum)
    target = (len(rows), len(cols))
    # Anti-aliasing needs samples below the texture resolution. Read the native
    # slice while it is affordable, otherwise a 2x supersample of the texture.
    native_cells, target_cells = len(a) * len(b), len(rows) * len(cols)
    if native_cells <= SLICE_NATIVE_BUDGET:
        read_cols, read_rows = np.arange(len(a)), np.arange(len(b))
    elif target_cells * 4 <= SLICE_SUPERSAMPLE_BUDGET:
        read_cols = indices(len(a), len(cols) * 2)
        read_rows = indices(len(b), len(rows) * 2)
    else:
        read_cols, read_rows = cols, rows
    method = resample.method(interpolation)
    key = ("preview", kind, actual, maximum, method)
    if key in survey.cache:
        sampled = survey.cache[key]
        survey.cache.move_to_end(key)
    else:
        if kind == "time":
            ids = preview_ids(survey, b[read_rows], a[read_cols])
            sampled = read_samples(survey, ids, [sample])[..., 0]
        else:
            ids = preview_ids(survey, [actual], a[read_cols])[0] if kind == "inline" else preview_ids(survey, a[read_cols], [actual])[:, 0]
            sampled = read_samples(survey, ids, read_rows).T
        if sampled.shape != target:
            sampled = resample.resample(sampled, target[1], target[0], method)
        survey.cache[key] = sampled
    return dict(kind=kind, position=actual, requested_position=position,
                a=a[cols].tolist(), b=b[rows].tolist(), amplitude=serial(sampled),
                native_shape=[len(b), len(a)], render_shape=[len(read_rows), len(read_cols)],
                interpolation=method), sampled


def regular_axis(values):
    coords = np.unique(values.astype(np.int64))
    if len(coords) < 2:
        return coords
    step = int(np.gcd.reduce(np.diff(coords)))
    size = int((coords[-1] - coords[0]) // step + 1)
    if size > 100000:
        raise ValueError("Horizon coordinates do not form a practical regular grid.")
    return np.arange(coords[0], coords[-1] + step, step)


def horizon_grid(horizon):
    if hasattr(horizon, "_grid3d"):
        return horizon._grid3d
    y, x = regular_axis(horizon.data[:, 0]), regular_axis(horizon.data[:, 1])
    if len(x) * len(y) > 8_000_000:
        raise ValueError(
            "Horizon grid exceeds 8 million cells; check coordinate spacing."
        )
    grid = np.full((len(y), len(x)), np.nan)
    row, col = np.searchsorted(y, horizon.data[:, 0]), np.searchsorted(
        x, horizon.data[:, 1]
    )
    keys = row * len(x) + col
    if len(np.unique(keys)) != len(keys):
        raise ValueError(
            f"{horizon.name}: duplicate Inline/Crossline horizon coordinates."
        )
    grid[row, col] = horizon.data[:, 2]
    horizon._grid3d = (x, y, grid)
    if not hasattr(horizon, "_mesh3d"):
        horizon._mesh3d = OrderedDict()
    return horizon._grid3d


def horizon_mesh(horizon, maximum=256):
    if not hasattr(horizon, "_mesh3d"):
        horizon._mesh3d = OrderedDict()
    if maximum in horizon._mesh3d:
        return horizon._mesh3d[maximum]
    y, x = regular_axis(horizon.data[:, 0]), regular_axis(horizon.data[:, 1])
    rows, cols = indices(len(y), maximum), indices(len(x), maximum)
    xx, yy = np.meshgrid(x[cols], y[rows])
    # Gather just preview vertices; no native-resolution floating-point grid.
    row = np.searchsorted(y, horizon.data[:, 0])
    col = np.searchsorted(x, horizon.data[:, 1])
    keys = row * len(x) + col
    order = np.argsort(keys)
    sorted_keys = keys[order]
    if np.any(np.diff(sorted_keys) == 0):
        raise ValueError(f"{horizon.name}: duplicate Inline/Crossline horizon coordinates.")
    wanted = (rows[:, None] * len(x) + cols[None, :]).ravel()
    positions = np.searchsorted(sorted_keys, wanted)
    found = positions < len(keys)
    found &= sorted_keys[np.minimum(positions, len(keys)-1)] == wanted
    zz = np.full(len(wanted), np.nan)
    zz[found] = horizon.data[order[positions[found]], 2]
    zz = zz.reshape(len(rows), len(cols))
    # Count observed native picks in compressed coordinate bins. This preserves
    # holes inside coarse quads without allocating a full native grid/mask.
    rb = np.unique(np.r_[rows, rows+1])
    cb = np.unique(np.r_[cols, cols+1])
    bins = np.searchsorted(rb, row, side="right")-1
    bins = bins * len(cb) + np.searchsorted(cb, col, side="right")-1
    counts = np.bincount(bins, minlength=len(rb)*len(cb)).reshape(len(rb), len(cb))
    total = np.pad(counts, ((1,0),(1,0))).cumsum(0).cumsum(1)
    r0 = np.searchsorted(rb, rows[:-1])[:, None]
    r1 = np.searchsorted(rb, rows[1:]+1)[:, None]
    c0 = np.searchsorted(cb, cols[:-1])[None, :]
    c1 = np.searchsorted(cb, cols[1:]+1)[None, :]
    observed = total[r1,c1]-total[r0,c1]-total[r1,c0]+total[r0,c0]
    expected = (np.diff(rows)+1)[:,None]*(np.diff(cols)+1)[None,:]
    valid = observed == expected
    rr, cc = np.where(valid)
    width = len(cols)
    a = rr * width + cc
    b = a + 1
    c = a + width
    d = c + 1
    faces = np.concatenate([np.stack([a, b, d], axis=1), np.stack([a, d, c], axis=1)])
    result = dict(
        x=xx.ravel().tolist(),
        y=yy.ravel().tolist(),
        z=serial(zz.ravel()),
        scalar=serial(zz.ravel()),
        # Native picks, not preview samples: extrema remain stable at every quality.
        twt_range=[float(horizon.data[:, 2].min()), float(horizon.data[:, 2].max())],
        i=faces[:, 0].tolist(),
        j=faces[:, 1].tolist(),
        k=faces[:, 2].tolist(),
        native_shape=[len(y), len(x)],
        preview_shape=list(zz.shape),
    )
    horizon._mesh3d[maximum] = result
    while len(horizon._mesh3d) > 3:
        horizon._mesh3d.popitem(last=False)
    return result


def horizon_intersection(horizon, kind, position, tolerance=4, maximum=None):
    if kind == "time":
        data = horizon.data[np.abs(horizon.data[:, 2] - position) <= tolerance]
        if maximum is not None and len(data) > maximum * maximum:
            data = data[indices(len(data), maximum * maximum)]
        return dict(
            kind=kind,
            position=position,
            x=data[:, 1].tolist(),
            y=data[:, 0].tolist(),
            z=np.full(len(data), position).tolist(),
            horizon_time=data[:, 2].tolist(),
        )
    axis = 0 if kind == "inline" else 1
    data = horizon.data[horizon.data[:, axis] == position]
    data = data[np.argsort(data[:, 1 - axis])]
    # Include breaks at absent expected coordinates, rather than bridging gaps.
    grid_axis = regular_axis(horizon.data[:, 1 if kind == "inline" else 0])
    xyz = []
    last = None
    for il, xl, t in data:
        n = int(np.searchsorted(grid_axis, xl if kind == "inline" else il))
        if last is not None and n > last + 1:
            xyz.append([None, None, None])
        xyz.append([float(xl), float(il), float(t)])
        last = n
    arr = list(zip(*xyz)) if xyz else [[], [], []]
    return dict(
        kind=kind, position=position, x=list(arr[0]), y=list(arr[1]), z=list(arr[2])
    )


def scene_data(survey, horizons, state):
    result = {
        "slices": [],
        "horizons": {},
        "bounds": {
            "x": [int(survey.crosslines[0]), int(survey.crosslines[-1])],
            "y": [int(survey.inlines[0]), int(survey.inlines[-1])],
            "z": [float(survey.times[0]), float(survey.times[-1])],
        },
    }
    stats = []
    maximum = state.scene.quality
    if state.scene.export_long_edge:
        count = sum(sl.visible for kind in ("inline", "crossline", "time") for sl in getattr(state.slices, kind))
        # Publication sampling follows final pixels; bound total geometry to
        # keep WebGL and the JSON payload affordable for multi-slice scenes.
        maximum = min(state.scene.export_long_edge, 2048, int((4_000_000 / max(count, 1)) ** .5))
    for kind in ["inline", "crossline", "time"]:
        for sl in getattr(state.slices, kind):
            if not sl.visible:
                continue
            # The texture is display data: bilinear while browsing, bicubic for
            # a publication capture. Slices share one amplitude window.
            data, values = slice_data(
                survey,
                kind,
                sl.position,
                maximum,
                state.seismic.interpolation,
            )
            data["id"] = sl.id
            result["slices"].append(data)
            finite = values[np.isfinite(values)]
            if len(finite):
                stats.append(finite)
    # All visible slices share one amplitude window, estimated from the displayed preview samples.
    samples = np.concatenate(stats) if stats else np.array([0.0])
    _, lo, hi = amplitude(samples, state.seismic)
    result.update(vmin=lo, vmax=hi)
    for h in state.horizons:
        if not h.visible or h.id not in horizons:
            continue
        source = horizons[h.id]
        if h.display_mode == "full_surface":
            mesh = horizon_mesh(source, state.scene.quality)
            result["horizons"][h.id] = {"mesh": mesh}
            # Full surface includes its whole valid footprint, even outside the cube.
            for axis in ["x", "y", "z"]:
                coords = source.data[:, {"x": 1, "y": 0, "z": 2}[axis]]
                result["bounds"][axis] = [
                    min(result["bounds"][axis][0], float(coords.min())),
                    max(result["bounds"][axis][1], float(coords.max())),
                ]
        else:
            lines = []
            for sl in result["slices"]:
                pts = horizon_intersection(
                    source, sl["kind"], sl["position"], h.time_slice_tolerance, state.scene.quality
                )
                # Intersection lives only on the finite seismic plane extent.
                if sl["kind"] == "time":
                    keep = [
                        i
                        for i, (x, y) in enumerate(zip(pts["x"], pts["y"]))
                        if sl["a"][0] <= x <= sl["a"][-1]
                        and sl["b"][0] <= y <= sl["b"][-1]
                    ]
                    pts = {
                        **pts,
                        **{
                            k: [pts[k][i] for i in keep]
                            for k in ["x", "y", "z", "horizon_time"]
                        },
                    }
                else:
                    axis = "x" if sl["kind"] == "inline" else "y"
                    for i, value in enumerate(pts[axis]):
                        if value is not None and not (
                            sl["a"][0] <= value <= sl["a"][-1]
                            and sl["b"][0] <= pts["z"][i] <= sl["b"][-1]
                        ):
                            for k in ["x", "y", "z"]:
                                pts[k][i] = None
                pts["slice_id"] = sl["id"]
                lines.append(pts)
            result["horizons"][h.id] = {"intersections": lines}
    return result
