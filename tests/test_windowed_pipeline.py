"""Scientific results are unchanged when native arrays become windowed sources."""
import io

import numpy as np
import pytest
import segyio
from PIL import Image

from backend import scene, slice_source
from backend.models import SectionRequest, Seismic, Settings, ViewState, ViewState3D
from backend.rendering import amplitude, render_with_metadata
from backend.section_service import interactive_section
from backend.segy import Survey


def force_windowed(monkeypatch, survey):
    monkeypatch.setattr(slice_source, "NATIVE_CACHE_ELEMENTS", 0)
    monkeypatch.setattr(scene, "NATIVE_CACHE_ELEMENTS", 0)
    survey.cache.clear()
    survey.render_cache.clear()

    def full_read(*args, **kwargs):
        raise AssertionError("The windowed pipeline must not materialize a full native section")
    monkeypatch.setattr(survey, "section", full_read)
    monkeypatch.setattr(scene, "timeslice", full_read)


@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("wiggle", [False, True])
@pytest.mark.parametrize("seismic", [
    Seismic(clip_percentile=93.1),
    Seismic(clip_percentile=81.3, symmetric=False, reverse_polarity=True),
    Seismic(clip_mode="manual", vmin=-12.1, vmax=35.7, reverse_polarity=True),
])
def test_2d_exact_raster_range_and_trace_paths(wide_cube, monkeypatch, background, wiggle, seismic):
    seismic = seismic.model_copy(update=dict(background_interpolation=background,
        wiggle_interpolation=wiggle, wiggle=True, variable_area=True))
    request = SectionRequest(section_number=12, seismic=seismic,
        x_range=(39.2, 70.4), time_range=(217.3, 251.8), target_width=73, target_height=51,
        trace_viewport_width=340, trace_viewport_height=80)
    expected = interactive_section(wide_cube, {}, request)
    force_windowed(monkeypatch, wide_cube)
    assert interactive_section(wide_cube, {}, request) == expected


@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("reverse", [False, True])
@pytest.mark.parametrize("horizon_amplitudes", [False, True])
def test_scene_exact_shared_clipping_and_all_three_planes(cube, horizon, monkeypatch,
                                                        background, reverse, horizon_amplitudes):
    state = ViewState3D(slices={
        "inline": [{"id": "i", "position": 12}],
        "crossline": [{"id": "x", "position": 33}],
        "time": [{"id": "t", "position": 205}],
    }, seismic={"background_interpolation": background, "reverse_polarity": reverse,
                "symmetric": False, "clip_percentile": 73.4, "wiggle": True, "variable_area": True},
        horizons=[{"id": "h", "name": "h", "color_by": "amplitude", "display_mode": "full_surface"}]
                 if horizon_amplitudes else [])
    expected = scene.scene_data(cube, {"h": horizon}, state)
    force_windowed(monkeypatch, cube)
    assert scene.scene_data(cube, {"h": horizon}, state) == expected


@pytest.mark.parametrize("background", [False, True])
def test_export_png_pixels_and_colorbar_match_native(cube, monkeypatch, background):
    state = ViewState(section_number=12, seismic={"reverse_polarity": True,
        "symmetric": False, "background_interpolation": background,
        "wiggle": True, "variable_area": True}, trace_viewport_height=40)
    settings = Settings(format="png", dpi=300, width=40, height=30)
    expected = render_with_metadata(cube, {}, state, settings)
    force_windowed(monkeypatch, cube)
    actual = render_with_metadata(cube, {}, state, settings)
    assert actual.colorbar_range == expected.colorbar_range
    np.testing.assert_array_equal(np.asarray(Image.open(io.BytesIO(actual.data))),
                                  np.asarray(Image.open(io.BytesIO(expected.data))))


def test_cached_native_limits_survive_viewport_edits_but_not_clipping_edits(cube, monkeypatch):
    force_windowed(monkeypatch, cube)
    request = SectionRequest(section_number=12, target_width=30, target_height=40)
    first = interactive_section(cube, {}, request)
    original = slice_source.SliceSource.iter_blocks
    calls = []
    def counted(self, *args, **kwargs):
        calls.append(self.cache_id)
        yield from original(self, *args, **kwargs)
    monkeypatch.setattr(slice_source.SliceSource, "iter_blocks", counted)
    request.x_range = (31.2, 35.3)
    request.seismic.reverse_colormap = True
    second = interactive_section(cube, {}, request)
    assert (first["vmin"], first["vmax"]) == (second["vmin"], second["vmax"])
    assert not calls
    request.seismic.clip_percentile = 70
    third = interactive_section(cube, {}, request)
    assert calls and third["vmax"] != second["vmax"]


def test_empty_horizon_does_not_promote_slice_percentile(cube, monkeypatch):
    # float32 subtraction inside NumPy percentile differs from float64. An
    # all-missing horizon was omitted from the original shared distribution.
    monkeypatch.setattr(scene, "horizon_amplitude_mesh", lambda *args: {
        "x": [], "y": [], "z": [], "amplitude": [None], "i": [], "j": [], "k": []})
    state = ViewState3D(slices={"inline": [{"id": "i", "position": 12}]},
        seismic={"symmetric": False, "clip_percentile": 71.2345},
        horizons=[{"id": "h", "name": "h", "color_by": "amplitude", "display_mode": "full_surface"}])
    class MissingHorizon:
        data = np.array([[10, 30, 204]])
    expected = amplitude(cube.section("inline", 12)[2], state.seismic)[1:]
    force_windowed(monkeypatch, cube)
    result = scene.scene_data(cube, {"h": MissingHorizon()}, state)
    assert (result["vmin"], result["vmax"]) == expected


@pytest.mark.parametrize("sample_format,missing_time", [(6, False), (6, True), (2, False), (9, False)])
def test_regular_time_preserves_native_dtype_and_empty_source_promotion(tmp_path, monkeypatch,
                                                                      sample_format, missing_time):
    path = tmp_path / "precise.segy"
    spec = segyio.spec()
    spec.sorting, spec.format = 2, sample_format
    spec.samples, spec.ilines, spec.xlines = list(range(16)), [10, 12], [30, 33]
    dtype = {6: np.float64, 2: np.int32, 9: np.int64}[sample_format]
    with segyio.create(str(path), spec) as file:
        for k, (il, xl) in enumerate((i, x) for i in spec.ilines for x in spec.xlines):
            file.header[k] = {189: il, 21: xl}
            values = (np.arange(16, dtype=np.float64) * .123456789123 + k * .01234567891 + 2
                      if sample_format == 6 else np.arange(16, dtype=dtype) + 2 ** 25 + 9 * k)
            if missing_time:
                values[4] = np.nan
            file.trace[k] = np.asarray(values, dtype=dtype)
        file.bin[segyio.BinField.Interval] = 1000
    survey = Survey(path, geometry_mode="regular")
    state = ViewState3D(slices={"inline": [{"id": "i", "position": 10}],
                               "time": [{"id": "t", "position": 4}]},
                       seismic={"symmetric": False, "clip_percentile": 91.237})
    expected = scene.scene_data(survey, {}, state)
    force_windowed(monkeypatch, survey)
    assert scene.scene_data(survey, {}, state) == expected
