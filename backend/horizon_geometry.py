"""Display extents from horizon picks, with no invented seismic samples."""
import numpy as np


def has_seismic(geometry):
    return geometry is not None and getattr(geometry, "has_seismic", True)


def _pick_axes(horizon):
    cached = getattr(horizon, "_geometry_axes", None)
    if cached is None:
        # Picks are immutable after loading, like the existing horizon mesh
        # cache. Keep only small 1D axes, not another copy of the pick matrix.
        cached = (np.unique(horizon.data[:, 0]), np.unique(horizon.data[:, 1]),
                  float(horizon.data[:, 2].min()), float(horizon.data[:, 2].max()))
        horizon._geometry_axes = cached
    return cached


class HorizonGeometry:
    has_seismic = False

    def __init__(self, horizons):
        layers = list(horizons.values())
        if not layers:
            raise ValueError("请先导入层位或 SEG-Y 数据。")
        # Reduce each file before joining; never expand sparse line numbers to
        # a synthetic volume or allocate a time-sample axis.
        axes = [_pick_axes(h) for h in layers]
        self.inlines = np.unique(np.concatenate([axis[0] for axis in axes]))
        self.crosslines = np.unique(np.concatenate([axis[1] for axis in axes]))
        low, high = min(axis[2] for axis in axes), max(axis[3] for axis in axes)
        self.times = np.array([low - .5, high + .5] if low == high else [low, high])

    def metadata(self):
        return {
            "filename": "层位数据", "inlines": self.inlines.tolist(), "crosslines": self.crosslines.tolist(),
            "time_range": self.times.tolist(), "samples": 0, "sample_interval": 0, "traces": 0,
            "sample_format": None, "geometry_cached": False, "geometry_cache_saved": False,
        }

    def section_axes(self, kind, position):
        if kind not in ("inline", "crossline"):
            raise ValueError("Unknown section type.")
        axis = self.inlines if kind == "inline" else self.crosslines
        if position not in axis:
            raise ValueError("Section does not exist in the loaded horizons.")
        return (self.crosslines if kind == "inline" else self.inlines), self.times

    def slice_frame(self, kind, position):
        if kind == "time":
            if not self.times[0] <= position <= self.times[-1]:
                raise ValueError("Time slice is outside the horizon time range.")
            a, b = self.crosslines, self.inlines
        else:
            a, b = self.section_axes(kind, position)
        ar, br = [float(a[0]), float(a[-1])], [float(b[0]), float(b[-1])]
        return {
            "kind": kind, "position": position, "requested_position": position,
            "a": ar, "b": br, "source_a_range": ar, "source_b_range": br,
            "amplitude": [], "geometry_only": True, "has_seismic": False,
            "native_shape": [0, 0], "render_shape": [0, 0], "preview_shape": [0, 0],
            "interpolation": "none",
        }
