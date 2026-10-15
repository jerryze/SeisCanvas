"""Independent 2D Sinc controls, source invariants and export reconstruction."""

from collections import OrderedDict
import io

import numpy as np
import pytest
from PIL import Image

from backend import resample
from backend.models import SectionRequest, Seismic, Settings, ViewState
from backend.rendering import render
from backend.section_service import interactive_section
from backend.trace_overlay import build_trace_overlay


class NativeSurvey:
    def __init__(self, x=None, time=None, z=None):
        self.x = np.asarray([30, 33, 38] if x is None else x, dtype=float)
        self.time = np.asarray(np.arange(16) * 4 + 200 if time is None else time, dtype=float)
        self.z = (np.repeat(np.sin(np.arange(len(self.time)))[:, None], len(self.x), axis=1)
                  if z is None else np.asarray(z)).astype(np.float32)
        self.render_cache = OrderedDict()
        self.calls = 0

    def section(self, *args):
        self.calls += 1
        return self.x, self.time, self.z


def fail_legacy(*args, **kwargs):
    raise AssertionError("2D must not resize colour pixels or quantize amplitudes")


@pytest.mark.parametrize("background", [False, True])
@pytest.mark.parametrize("wiggle", [False, True])
def test_independent_switches_native_knots_and_shared_area_sequence(background, wiggle, monkeypatch):
    monkeypatch.setattr(resample, "resample", fail_legacy)
    monkeypatch.setattr(resample, "display_values", fail_legacy)
    survey = NativeSurvey()
    source = survey.z.copy()
    request = SectionRequest(section_number=1, target_width=80, target_height=120,
        trace_viewport_width=600, trace_viewport_height=100,
        seismic=Seismic(background_interpolation=background, wiggle_interpolation=wiggle,
                        wiggle=True, variable_area=True, clip_mode="manual", vmin=-3, vmax=3))
    section = interactive_section(survey, {}, request)
    assert survey.calls == 1
    assert section["background_interpolation"] is background
    assert section["wiggle_interpolation"] is wiggle
    assert section["preview_shape"] == ([120, 80] if background else [16, 3])
    if not background:
        np.testing.assert_array_equal(section["z"], source)
        np.testing.assert_array_equal(section["x"], survey.x)
        assert section["x_edges"] == [28.5, 31.5, 35.5, 40.5]
    overlay = section["trace_overlay"]
    curve = set(zip(overlay["wiggle"]["x"], overlay["wiggle"]["time"]))
    # First trace's native knot positions survive reconstruction unchanged.
    for at, amplitude in zip(survey.time, source[:, 0]):
        assert (30 + float(amplitude) * 1.5 / 3, float(at)) in curve
    # Area and line vertices come from the very same reconstructed sequence.
    baselines = set(survey.x)
    assert all((x, at) in curve for x, at in zip(overlay["variable_area"]["x"], overlay["variable_area"]["time"])
               if x is not None and x not in baselines)
    if wiggle:
        assert any(at not in set(survey.time) for at in overlay["wiggle"]["time"] if at is not None)
    np.testing.assert_array_equal(survey.z, source)


def test_reconstructed_original_knots_are_not_quantized_or_clamped(monkeypatch):
    monkeypatch.setattr(resample, "resample", fail_legacy)
    monkeypatch.setattr(resample, "display_values", fail_legacy)
    rng = np.random.default_rng(13)
    source = rng.standard_normal((16, 8), dtype=np.float32)
    survey = NativeSurvey(x=np.arange(8) * 4, z=source)
    request = SectionRequest(section_number=1, target_width=8, target_height=16,
                             seismic={"clip_mode": "manual", "vmin": -0.1, "vmax": 0.1})
    section = interactive_section(survey, {}, request)
    np.testing.assert_array_equal(section["z"], source)
    assert np.max(np.asarray(section["z"])) > section["vmax"]
    assert np.min(np.asarray(section["z"])) < section["vmin"]


def test_zoom_uses_full_sinc_halo_and_fractional_pan_changes_cache_pixels(monkeypatch):
    source = np.zeros((32, 8), dtype=np.float32)
    source[8] = 1
    survey = NativeSurvey(x=np.arange(8), time=np.arange(32) * 4 + 200, z=source)
    calls = []
    original = resample.seismic_raster
    def capture(*args, **kwargs):
        calls.append(args[2].shape)
        return original(*args, **kwargs)
    monkeypatch.setattr(resample, "seismic_raster", capture)
    request = SectionRequest(section_number=1, x_range=(1, 6), time_range=(236.4, 247.4),
                             target_width=40, target_height=60)
    first = interactive_section(survey, {}, request)
    expected, *_ = original(survey.x, survey.time, source, 40, 60, first["raster_extent"])
    np.testing.assert_array_equal(first["z"], expected)
    # The impulse is outside the native visible window, but within sinc taps.
    assert first["window"]["time_range"][0] == 236
    assert np.max(np.abs(np.asarray(first["z"]))) > 0.01
    request.time_range = (236.5, 247.5)
    second = interactive_section(survey, {}, request)
    assert first["window"] == second["window"]
    assert first["time"] != second["time"]
    assert not np.array_equal(first["z"], second["z"])
    assert calls == [source.shape, source.shape]


def test_subsample_zoom_smooths_without_native_upscale_cap_or_unbounded_trace_grid():
    survey = NativeSurvey()
    request = SectionRequest(section_number=1, x_range=(32, 34), time_range=(204.1, 204.100001),
        target_width=600, target_height=500, trace_viewport_height=600,
        seismic={"wiggle": True, "variable_area": True, "adaptive_resolution": False})
    section = interactive_section(survey, {}, request)
    assert section["preview_shape"] == [500, 600]
    overlay = section["trace_overlay"]
    assert len(overlay["wiggle"]["x"]) <= overlay["trace_count"] * 620
    assert overlay["viewport_height"] == 600


@pytest.mark.parametrize("fmt", ["png", "svg", "pdf"])
@pytest.mark.parametrize("canvas", ["fit", "fixed"])
@pytest.mark.parametrize("background", [False, True])
def test_export_reconstructs_once_or_keeps_exact_native_cells(fmt, canvas, background, monkeypatch):
    from matplotlib.figure import Figure
    captured, calls = [], []
    original = resample.seismic_raster
    def capture_figure(*args, **kwargs):
        figure = Figure(*args, **kwargs)
        captured.append(figure)
        return figure
    def capture_raster(*args, **kwargs):
        calls.append(args[2].shape)
        return original(*args, **kwargs)
    monkeypatch.setattr("backend.rendering.Figure", capture_figure)
    monkeypatch.setattr(resample, "seismic_raster", capture_raster)
    monkeypatch.setattr(resample, "resample", fail_legacy)
    survey = NativeSurvey()
    view = ViewState(section_number=1, trace_viewport_width=600, trace_viewport_height=100,
                     seismic={"background_interpolation": background, "wiggle_interpolation": True,
                              "wiggle": True, "variable_area": True})
    expected = build_trace_overlay(survey.x, survey.time, survey.z, view, -1, 1)
    output = render(survey, {}, view, Settings(canvas=canvas, width=60, height=40, long_edge=600, format=fmt))
    assert survey.calls == 1 and len(calls) == int(background)
    ax = captured[0].axes[0]
    if background:
        assert calls == [survey.z.shape]
        assert ax.images[0].get_interpolation() == "none"
        assert min(ax.images[0].get_array().shape) > 100
    else:
        assert not ax.images
        np.testing.assert_array_equal(ax.collections[0].get_array(), survey.z)
        assert ax.collections[0].get_rasterized()
    # Geometry does not depend on either output DPI or background mode.
    line = ax.collections[-1]
    assert not line.get_rasterized() and len(line.get_segments()) == expected["trace_count"]
    if fmt == "png":
        with Image.open(io.BytesIO(output)) as png:
            assert png.width > 0 and png.height > 0
    else:
        assert output.startswith(b"<?xml" if fmt == "svg" else b"%PDF")


def test_valid_wide_fixed_page_caps_raster_and_preserves_physical_page(monkeypatch):
    calls = []
    original = resample.seismic_raster
    def capture(*args, **kwargs):
        calls.append(args[3:5])
        return original(*args, **kwargs)
    monkeypatch.setattr(resample, "seismic_raster", capture)
    survey = NativeSurvey(time=[200, 204], z=[[0, 1, 0], [1, 0, -1]])
    settings = Settings(canvas="fixed", width=500, height=30, dpi=600, format="svg")
    output = render(survey, {}, ViewState(section_number=1), settings)
    assert len(calls) == 1 and max(calls[0]) <= resample.MAX_RENDER_DIMENSION
    assert output.startswith(b"<?xml") and b'width="1417.322' in output
