"""Physical-coordinate 3D slice and horizon geometry. No renderer coordinates here."""

from collections import OrderedDict
import numpy as np
import segyio
from backend.core import amplitude


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
    grid[
        np.searchsorted(survey.inlines, survey.ils),
        np.searchsorted(survey.crosslines, survey.xls),
    ] = values
    survey.cache[key] = grid
    while len(survey.cache) > 12:
        survey.cache.popitem(last=False)
    return actual, grid


def slice_data(survey, kind, position, maximum=256):
    if kind == "time":
        actual, values = timeslice(survey, position)
        a, b = survey.crosslines, survey.inlines
    else:
        if position != int(position):
            raise ValueError("Inline and Crossline positions must be integers.")
        coords, b, raw = survey.section(kind, int(position))
        a = survey.crosslines if kind == "inline" else survey.inlines
        # Reindex to the survey axis; missing traces stay masked.
        values = np.full((len(b), len(a)), np.nan, dtype=np.float32)
        values[:, np.searchsorted(a, coords)] = raw
        actual = int(position)
    rows, cols = indices(len(b), maximum), indices(len(a), maximum)
    sampled = values[np.ix_(rows, cols)].copy()
    # A coarse cell may not cover an unobserved trace/sample.
    missing = ~np.isfinite(values)
    if missing.any():
        for ri in range(len(rows) - 1):
            for ci in range(len(cols) - 1):
                if missing[
                    rows[ri] : rows[ri + 1] + 1, cols[ci] : cols[ci + 1] + 1
                ].any():
                    sampled[ri : ri + 2, ci : ci + 2] = np.nan
    return (
        dict(
            kind=kind,
            position=actual,
            requested_position=position,
            a=a[cols].tolist(),
            b=b[rows].tolist(),
            amplitude=serial(sampled),
            native_shape=list(values.shape),
        ),
        values,
    )


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
    horizon._mesh3d = OrderedDict()
    return horizon._grid3d


def horizon_mesh(horizon, maximum=256):
    x, y, grid = horizon_grid(horizon)
    if maximum in horizon._mesh3d:
        return horizon._mesh3d[maximum]
    rows, cols = indices(len(y), maximum), indices(len(x), maximum)
    xx, yy = np.meshgrid(x[cols], y[rows])
    zz = grid[np.ix_(rows, cols)]
    # Integral mask tests every native cell inside each coarse quad. Even tiny holes
    # remain holes after downsampling; no triangulation across missing picks.
    bad = (
        np.pad((~np.isfinite(grid)).astype(np.int32), ((1, 0), (1, 0)))
        .cumsum(0)
        .cumsum(1)
    )
    r0, r1 = rows[:-1, None], rows[1:, None] + 1
    c0, c1 = cols[None, :-1], cols[None, 1:] + 1
    valid = (bad[r1, c1] - bad[r0, c1] - bad[r1, c0] + bad[r0, c0]) == 0
    rr, cc = np.where(valid)
    width = len(cols)
    a = rr * width + cc
    b = a + 1
    c = a + width
    d = c + 1
    faces = np.concatenate([np.stack([a, b, d], axis=1), np.stack([a, d, c], axis=1)])
    # Deduplicated grid edges, no diagonal edges in the wireframe.
    edges = np.concatenate(
        [
            np.stack([a, b], axis=1),
            np.stack([b, d], axis=1),
            np.stack([c, d], axis=1),
            np.stack([a, c], axis=1),
        ]
    )
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    result = dict(
        x=xx.ravel().tolist(),
        y=yy.ravel().tolist(),
        z=serial(zz.ravel()),
        i=faces[:, 0].tolist(),
        j=faces[:, 1].tolist(),
        k=faces[:, 2].tolist(),
        edges=edges.tolist(),
        native_shape=list(grid.shape),
        preview_shape=list(zz.shape),
    )
    horizon._mesh3d[maximum] = result
    while len(horizon._mesh3d) > 3:
        horizon._mesh3d.popitem(last=False)
    return result


def horizon_intersection(horizon, kind, position, tolerance=4):
    if kind == "time":
        data = horizon.data[np.abs(horizon.data[:, 2] - position) <= tolerance]
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
    grid_axis = horizon_grid(horizon)[0 if kind == "inline" else 1]
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
    for kind in ["inline", "crossline", "time"]:
        for sl in getattr(state.slices, kind):
            if not sl.visible:
                continue
            data, values = slice_data(survey, kind, sl.position, state.scene.quality)
            data["id"] = sl.id
            result["slices"].append(data)
            finite = values[np.isfinite(values)]
            if len(finite):
                stats.append(finite)
    # All visible slices share one amplitude window, calculated before decimation.
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
                    source, sl["kind"], sl["position"], h.time_slice_tolerance
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
