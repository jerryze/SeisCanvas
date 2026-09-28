"""Display interpolation, adaptive resolution and original-data probing."""

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import resample
from backend.core import display_raster, render, window_indices
from backend.models import Seismic, Settings, ViewState
import backend.main as server


# ------------------------------------------------------------------ resampler


def test_interpolation_methods_and_shapes():
    window = np.arange(12, dtype=np.float32).reshape(3, 4)
    assert np.array_equal(resample.resample(window, 4, 3, "bilinear"), window)
    for name in ("nearest", "bilinear", "bicubic"):
        out = resample.resample(window, 8, 6, name)
        assert out.shape == (6, 8) and out.dtype == np.float32
        # Cubic overshoot is clipped: no display value leaves the real range.
        assert out.min() >= window.min() and out.max() <= window.max()
    with pytest.raises(ValueError):
        resample.resample(window[:, :, None], 2, 2, "bilinear")
    with pytest.raises(ValueError):
        resample.resample(window, 0, 4, "bilinear")


def test_method_normalisation():
    assert resample.method(None) == "bilinear"
    assert resample.method("BICUBIC") == "bicubic"
    assert resample.method("nope") == "bilinear"
    assert resample.method(None, "nearest") == "nearest"


def test_downsampling_is_antialiased_except_for_nearest():
    checker = (np.indices((64, 64)).sum(0) % 2).astype(np.float32)
    for name in ("bilinear", "bicubic"):
        small = resample.resample(checker, 8, 8, name)
        assert small.std() < 0.05, name
    # Nearest is the explicit debug mode: it keeps real samples, aliasing and all.
    aliased = resample.resample(checker, 8, 8, "nearest")
    assert set(np.unique(aliased)).issubset({0.0, 1.0})


def test_upsampling_interpolates_between_samples():
    window = np.array([[0.0, 10.0]], dtype=np.float32)
    smooth = resample.resample(window, 5, 1, "bilinear")
    assert smooth[0, 0] == 0 and smooth[0, -1] == 10
    assert 0 < smooth[0, 2] < 10
    nearest = resample.resample(window, 5, 1, "nearest")
    assert set(np.unique(nearest)).issubset({0.0, 10.0})


def test_fit_target_matches_pixels_and_stays_bounded():
    assert resample.fit_target(586, 256, 1000, 520) == (1000, 520)
    assert resample.fit_target(586, 256) == (586, 256)
    # Never invent more than MAX_UPSCALE samples per axis.
    width, height = resample.fit_target(100, 100, 4000, 4000)
    assert width <= int(np.ceil(100 * resample.MAX_UPSCALE)) + 1
    # The interactive node budget wins over a huge viewport.
    width, height = resample.fit_target(4000, 4000, 4000, 4000)
    assert width * height <= resample.INTERACTIVE_BUDGET * 1.1
    # A single axis can never exceed the hard dimension limit.
    width, height = resample.fit_target(20000, 40, 40000, 100)
    assert width <= resample.MAX_RENDER_DIMENSION


def test_display_values_are_compact_but_far_finer_than_the_colour_ramp():
    values = np.linspace(-7946.125, 7946.125, 1000).astype(np.float32)
    vmin, vmax = -7946.125, 7946.125
    assert resample.display_decimals(vmin, vmax) == 0
    written = resample.display_values(values.reshape(50, 20), vmin, vmax, "bilinear")
    flat = np.array([v for row in written for v in row])
    # 12 bit of the colour range: twenty times finer than the 256 entry ramp
    # (about 62 amplitude units) and written with short decimals.
    assert np.abs(flat - values).max() < (vmax - vmin) / resample.DISPLAY_STEPS
    assert np.abs(flat - values).max() < (vmax - vmin) / 256 / 10
    assert all(len(f"{v:g}") <= 6 for row in written for v in row[:5])
    # Nearest mode is the diagnostic one: real samples, exact values.
    exact = resample.display_values(values.reshape(50, 20), vmin, vmax, "nearest")
    assert np.array_equal(np.array(exact).reshape(-1), values)


# ------------------------------------------------------------- core windowing


def test_window_indices_cover_the_visible_range_with_slack():
    coordinates = np.arange(0, 100, dtype=float)
    assert window_indices(coordinates, None) == (0, 99)
    assert window_indices(coordinates, (20, 30)) == (19, 31)
    assert window_indices(coordinates, (-50, 5)) == (0, 6)
    assert window_indices(coordinates, (95, 500)) == (94, 99)


class FakeSurvey:
    """z grows with time and crossline so orientation and windows are checkable."""

    def __init__(self):
        self.x = np.arange(10, dtype=float) * 2.0
        self.t = np.arange(0, 40, 4, dtype=float)
        self.z = (
            np.arange(10, dtype=np.float32)[:, None] * 10
            + np.arange(10, dtype=np.float32)[None, :]
        )

    def section(self, mode, number):
        return self.x, self.t, self.z


def test_display_raster_windows_the_source_and_keeps_world_extent():
    survey = FakeSurvey()
    state = ViewState(section_number=1, x_range=(4, 12), time_range=(8, 20))
    raster, extent, source = display_raster(
        survey.x, survey.t, survey.z, state, Settings(width=60, height=60, dpi=300)
    )
    # window_indices adds one sample of slack on each side of the range:
    # crossline 4..12 -> x index 1..7, TWT 8..20 -> t index 1..6.
    assert source == (7, 6)  # (width, height) of the source window
    assert extent == (1.5, 14.5, 3.5, 24.5)
    # Export resolution is matched per axis, up to the 32x upscale guard.
    assert raster.shape == (192, 224)
    # The source array is never modified: rendering stays in the render layer.
    np.testing.assert_array_equal(survey.z, FakeSurvey().z)


@pytest.mark.parametrize("resolution,expected", [("export", 320), ("view", 30)])
def test_export_raster_resolution_modes(resolution, expected):
    survey = FakeSurvey()
    state = ViewState(section_number=1)
    settings = Settings(width=60, height=60, dpi=300, resolution=resolution, interpolation="bicubic")
    raster, _, _ = display_raster(survey.x, survey.t, survey.z, state, settings)
    # 60 mm at 300 dpi is 708 px. The export grid stops at 32x the real samples;
    # the view grid is the interactive one (3x cap on a 10 sample source).
    assert settings.canvas_pixels() == (709, 709)
    assert raster.shape == (expected, expected)


# ------------------------------------------------------------------ /api/section


@pytest.fixture
def client(cube, horizon):
    server.survey = cube
    server.horizons.clear()
    server.horizons["h"] = horizon
    return TestClient(server.app)


def post_section(client, **body):
    response = client.post("/api/section", json={"section_number": 12, **body})
    assert response.status_code == 200, response.text
    return response.json()


def test_section_defaults_to_interactive_bilinear(client):
    data = post_section(client)
    assert data["interpolation"] == "bilinear"
    assert data["adaptive"] is True
    assert data["quality"] == "interactive"
    assert data["native_shape"] == [4, 3]
    assert data["render_shape"] == [4, 3]
    # No viewport was given, so the grid stays at the native sampling.
    assert data["preview_shape"] == [4, 3]
    assert data["window"]["x_range"] == [30.0, 38.0]
    assert data["window"]["time_range"] == [200.0, 212.0]


def test_section_zoom_returns_a_new_window_from_the_original(client):
    full = post_section(client)
    zoomed = post_section(
        client, x_range=[30, 33], time_range=[200, 208], target_width=30, target_height=24
    )
    # The returned raster keeps one sample of slack around the visible range.
    assert zoomed["window"]["x_range"] == [30.0, 38.0]
    assert zoomed["window"]["time_range"] == [200.0, 212.0]
    assert zoomed["render_shape"] == [4, 3]
    # Three real traces never become 30 invented ones: the grid stops at 3x.
    assert zoomed["preview_shape"] == [12, 9]
    assert len(zoomed["z"]) == 12 and len(zoomed["z"][0]) == 9
    # The colour range always comes from the original section, never from the
    # interpolated raster, so zooming does not change colours.
    assert (zoomed["vmin"], zoomed["vmax"]) == (full["vmin"], full["vmax"])


def test_section_zoom_fetches_less_than_the_full_section(wide_cube, tmp_path):
    """A narrow window must not ship the whole section to the browser."""
    from backend.core import Horizon

    server.survey = wide_cube
    server.horizons.clear()
    client = TestClient(server.app)
    full = post_section(client)
    windowed = post_section(
        client,
        x_range=[51, 75],
        time_range=[256, 268],
        target_width=30,
        target_height=18,
    )
    assert windowed["native_shape"] == [20, 20]
    assert windowed["render_shape"][1] < full["render_shape"][1]
    assert windowed["render_shape"][0] < full["render_shape"][0]
    left, right = windowed["window"]["x_range"]
    assert left <= 51 and right >= 75
    top, bottom = windowed["window"]["time_range"]
    assert top <= 256 and bottom >= 268
    # With enough real samples the display grid does match the viewport pixels
    # instead of the native sampling (which the full section falls back to).
    assert windowed["preview_shape"] == [18, 30]
    assert len(windowed["z"]) == 18 and len(windowed["z"][0]) == 30
    assert windowed["preview_shape"] != windowed["render_shape"]
    assert (windowed["vmin"], windowed["vmax"]) == (full["vmin"], full["vmax"])


def test_section_nearest_returns_real_samples_and_interpolation_is_recorded(client):
    nearest = post_section(client, interpolation="nearest", target_width=8, target_height=8)
    assert nearest["interpolation"] == "nearest"
    original = np.array(post_section(client)["z"]).reshape(-1)
    resampled = np.array(nearest["z"]).reshape(-1)
    assert set(np.unique(resampled)).issubset(set(np.unique(original)))
    # A grid that matches the source is never quantized either.
    assert sorted(np.unique(original)) == sorted(np.unique(np.array(post_section(client)["z"])))
    smooth = post_section(client, target_width=8, target_height=8, interpolation="bicubic")
    assert smooth["interpolation"] == "bicubic"
    assert not np.allclose(np.sort(smooth["z"]), np.sort(nearest["z"]))


def test_section_request_overrides_the_state_interpolation(client):
    body = {"seismic": {"interpolation": "nearest"}}
    assert post_section(client, **body)["interpolation"] == "nearest"
    assert post_section(client, **body, interpolation="bicubic")["interpolation"] == "bicubic"


def test_section_adaptive_resolution_can_be_disabled(client):
    adaptive = post_section(client, target_width=30, target_height=24)
    fixed = post_section(
        client, target_width=30, target_height=24, seismic={"adaptive_resolution": False}
    )
    assert adaptive["adaptive"] is True and adaptive["preview_shape"] == [12, 9]
    assert fixed["adaptive"] is False
    # Without adaptive resolution the grid follows the real samples.
    assert fixed["preview_shape"] == [4, 3]


def test_section_render_cache_reuses_the_same_window(client, monkeypatch):
    import backend.resample as resample_module
    calls = []
    original = resample_module.resample

    def counted(*args, **kwargs):
        calls.append(args[1:3])
        return original(*args, **kwargs)

    monkeypatch.setattr(resample_module, "resample", counted)
    body = {"target_width": 200, "target_height": 150, "interpolation": "bilinear"}
    post_section(client, **body)
    post_section(client, **body)
    assert len(calls) == 1


# ------------------------------------------------------------------- /api/sample


def test_sample_reads_the_original_segy(client):
    inline = client.post(
        "/api/sample",
        json={"kind": "inline", "position": 12, "crossline": 30, "time": 200},
    ).json()
    assert inline["amplitude"] == 1230.0  # t index 0 + 12*100 + 30
    assert (inline["inline"], inline["crossline"], inline["time"]) == (12, 30, 200)
    assert inline["source"] == "original"

    crossline = client.post(
        "/api/sample",
        json={"kind": "crossline", "position": 30, "inline": 12, "time": 212},
    ).json()
    assert crossline["amplitude"] == 1233.0  # t index 3 + 12*100 + 30

    time_slice = client.post(
        "/api/sample",
        json={"kind": "time", "position": 204, "inline": 10, "crossline": 38},
    ).json()
    assert time_slice["amplitude"] == 1039.0  # t index 1 + 1000 + 38


def test_sample_snaps_to_real_coordinates(client):
    reading = client.post(
        "/api/sample",
        json={"kind": "inline", "position": 12, "crossline": 31.4, "time": 207.5},
    ).json()
    assert (reading["crossline"], reading["time"]) == (30, 208)
    assert reading["amplitude"] == 1232.0


def test_sample_validates_coordinates(client):
    assert client.post("/api/sample", json={"kind": "inline", "position": 12}).status_code == 400
    assert client.post("/api/sample", json={"kind": "time", "position": 204}).status_code == 400
    assert client.post("/api/sample", json={"kind": "section"}).status_code == 422


def test_sample_needs_a_loaded_survey():
    server.survey = None
    assert TestClient(server.app).post(
        "/api/sample", json={"kind": "inline", "position": 1, "crossline": 1, "time": 1}
    ).status_code == 400


# --------------------------------------------------------------- Matplotlib export


def test_publication_export_renders_the_raster_at_the_output_resolution(cube, monkeypatch):
    from matplotlib.figure import Figure

    figures = []

    def capture(*args, **kwargs):
        figure = Figure(*args, **kwargs)
        figures.append(figure)
        return figure

    monkeypatch.setattr("backend.core.Figure", capture)
    state = ViewState(section_number=12)
    render(cube, {}, state, Settings(format="png", width=180, height=100, dpi=600))
    image = figures[0].axes[0].images[0]
    extent = image.get_extent()
    # Cell edges of the visible window: half a sample outside the coordinates.
    assert extent == [29.5, 38.5, 199.5, 212.5]
    # 3 traces and 4 samples cannot honestly fill 4252 x 2362 pixels.
    assert image.get_array().shape == (128, 96)
    assert figures[0].axes[0].get_xlim() == (29.5, 38.5)
    assert figures[0].axes[0].get_ylim() == (212, 200)


def test_view_resolution_export_reuses_the_interactive_grid(cube, monkeypatch):
    from matplotlib.figure import Figure

    figures = []

    def capture(*args, **kwargs):
        figure = Figure(*args, **kwargs)
        figures.append(figure)
        return figure

    monkeypatch.setattr("backend.core.Figure", capture)
    render(
        cube,
        {},
        ViewState(section_number=12),
        Settings(format="png", width=180, height=100, dpi=600, resolution="view"),
    )
    assert figures[0].axes[0].images[0].get_array().shape == (12, 9)


def test_export_clipping_ignores_interpolation_and_window(cube, monkeypatch):
    from matplotlib.figure import Figure

    figures = []

    def capture(*args, **kwargs):
        figure = Figure(*args, **kwargs)
        figures.append(figure)
        return figure

    monkeypatch.setattr("backend.core.Figure", capture)
    settings = Settings(format="png", width=180, height=100, dpi=600)
    # A zoomed bicubic export keeps the full-section colour range.
    zoomed = ViewState(section_number=12, x_range=(30, 33), seismic=Seismic(interpolation="bicubic"))
    render(cube, {}, zoomed, settings)
    zoomed_limits = figures[-1].axes[0].images[0].get_clim()
    render(cube, {}, ViewState(section_number=12), settings)
    full_limits = figures[-1].axes[0].images[0].get_clim()
    assert zoomed_limits == full_limits
