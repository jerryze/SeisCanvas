"""Display caches depend on sampling geometry, independently of trace styling."""

import numpy as np

from backend import resample
from backend.models import SectionRequest, Seismic, ViewState, ViewState3D
from backend.scene import scene_data
from backend.section_service import interactive_section, section_raster


def count_reconstructions(monkeypatch):
    calls = []
    original = resample.seismic_raster

    def reconstruct(*args, **kwargs):
        calls.append((args[3:5], kwargs.get("time_sinc", True)))
        return original(*args, **kwargs)

    monkeypatch.setattr(resample, "seismic_raster", reconstruct)
    return calls, original


def test_style_switches_reuse_raster_and_match_fresh_complete_responses(cube, monkeypatch):
    calls, _ = count_reconstructions(monkeypatch)
    requests, cached = [], []
    for polarity, wiggle_interpolation in [(False, False), (False, True), (True, False), (True, True)]:
        request = SectionRequest(
            section_number=10, target_width=80, target_height=60,
            trace_viewport_width=300, trace_viewport_height=200,
            seismic=Seismic(
                reverse_polarity=polarity, wiggle_interpolation=wiggle_interpolation,
                wiggle=True, variable_area=True, clip_mode="manual", vmin=-2000, vmax=2000,
            ),
        )
        requests.append(request)
        cached.append(interactive_section(cube, {}, request))
    assert len(calls) == 1
    assert all(result["z"] == cached[0]["z"] for result in cached)
    # A cached background cannot suppress the independent trace paths/metadata.
    assert cached[0]["trace_overlay"] != cached[2]["trace_overlay"]
    assert [result["wiggle_interpolation"] for result in cached] == [False, True, False, True]
    for request, result in zip(requests, cached):
        cube.render_cache.clear()
        assert interactive_section(cube, {}, request) == result
    assert len(calls) == 5


def test_vertical_3d_reuses_2d_background_after_trace_style_changes(cube, monkeypatch):
    calls, _ = count_reconstructions(monkeypatch)
    section = interactive_section(cube, {}, SectionRequest(
        section_number=10, target_width=120, target_height=80,
        seismic={"reverse_polarity": False, "wiggle_interpolation": False},
    ))
    scene = scene_data(cube, {}, ViewState3D(
        seismic={"reverse_polarity": True, "wiggle_interpolation": True},
        slices={"inline": [{"id": "il", "position": 10}]},
        scene={"quality": 128, "slice_viewports": {"il": (120, 80)}},
    ))
    plane = scene["slices"][0]
    assert len(calls) == 1
    assert plane["amplitude"] == section["z"]
    assert plane["a"] == section["x"] and plane["b"] == section["time"]
    assert plane["a_edges"] == section["x_edges"] and plane["b_edges"] == section["time_edges"]


def test_fractional_ranges_time_kernel_and_source_identity_invalidate_raster(cube, monkeypatch):
    calls, reconstruct = count_reconstructions(monkeypatch)
    x, time, native = cube.section("inline", 10)
    state = ViewState(section_number=10, x_range=(30.4, 37.4), time_range=(201, 211))

    def display(current, *, time_sinc=True, width=80, cache_id=("inline", 10)):
        result = section_raster(cube, x, time, native, current, width, 60,
                                cache_id=cache_id, time_sinc=time_sinc)
        expected, *_ = reconstruct(x, time, native, width, 60, result["extent"], time_sinc=time_sinc)
        np.testing.assert_array_equal(result["values"], expected)
        return result

    first = display(state)
    assert display(state)["values"] is first["values"]
    assert len(calls) == 1
    panned_x = display(state.model_copy(update={"x_range": (30.5, 37.5)}))
    panned_time = display(state.model_copy(update={"time_range": (201.1, 211.1)}))
    # These fractional pans share native window indices, but require new pixels.
    assert panned_x["window"] == panned_time["window"] == first["window"]
    assert not np.array_equal(first["values"], panned_x["values"])
    assert not np.array_equal(first["values"], panned_time["values"])
    assert len(calls) == 3
    spatial = display(state, time_sinc=False)
    assert spatial["interpolation"] == "linear"
    assert not np.array_equal(spatial["values"], first["values"])
    assert display(state, time_sinc=False)["values"] is spatial["values"]
    assert len(calls) == 4
    display(state, width=81)
    display(state, cache_id=("inline", 12))
    assert len(calls) == 6
