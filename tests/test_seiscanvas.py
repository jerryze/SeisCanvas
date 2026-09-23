from pathlib import Path
import io
import numpy as np
import pytest
import segyio
from fastapi.testclient import TestClient
from backend.core import Survey, Horizon, amplitude, horizon_preview, render
from backend.models import ViewState, Seismic, Settings, HorizonStyle
import backend.main as server


@pytest.fixture
def cube(tmp_path):
    path = tmp_path / "tiny.segy"
    spec = segyio.spec()
    spec.sorting = 2
    spec.format = 5
    spec.samples = [200, 204, 208, 212]
    spec.ilines = [10, 12]
    spec.xlines = [30, 33, 38]
    with segyio.create(str(path), spec) as f:
        k = 0
        for il in spec.ilines:
            for xl in spec.xlines:
                f.header[k] = {189: il, 21: xl, 193: xl, 109: 200, 117: 4000}
                f.trace[k] = np.arange(4, dtype=np.float32) + il * 100 + xl
                k += 1
        f.bin[segyio.BinField.Interval] = 4000
    return Survey(path)


def test_geometry_and_samples(cube):
    assert cube.inlines.tolist() == [10, 12]
    x, t, z = cube.section("inline", 12)
    assert x.tolist() == [30, 33, 38]
    assert t.tolist() == [200, 204, 208, 212]
    np.testing.assert_array_equal(z[:, 1], [1233, 1234, 1235, 1236])
    x, t, z = cube.section("crossline", 33)
    assert x.tolist() == [10, 12]
    np.testing.assert_array_equal(z[:, 0], [1033, 1034, 1035, 1036])
    assert cube.section("crossline", 33) is cube.section("crossline", 33)
    with pytest.raises(ValueError):
        cube.section("inline", 11)


def test_header_validation(cube):
    with pytest.raises(ValueError):
        Survey(cube.path, 189, 189)


def test_horizon_headers_and_sorting(tmp_path):
    p = tmp_path / "h.txt"
    p.write_text("inline\txline\ttime\n12 38 209\n12 30 205\n10 30 202\n")
    h = Horizon(p)
    assert h.section("inline", 12) == [[30, 205], [38, 209]]
    assert h.section("crossline", 30) == [[10, 202], [12, 205]]
    p.write_text("12 bad 100\n")
    with pytest.raises(ValueError):
        Horizon(p)


def test_horizon_custom_column_mapping(tmp_path):
    p = tmp_path / "mapped.dat"
    p.write_text(
        "# horizonName line trace x y depth\n"
        "ch81_6 400 870 19227380.0000 3962160.0000 602.7108\n"
        "ch81_6 400 871 19227400.0000 3962160.0000 602.2224\n"
    )
    preview = horizon_preview(p)
    assert preview["suggestions"] == {"inline": 1, "xline": 2, "time": 5}
    assert preview["columns"][5]["name"] == "depth"
    h = Horizon(p, columns=(1, 2, 5))
    assert h.data.tolist() == [[400, 870, 602.7108], [400, 871, 602.2224]]
    assert h.section("inline", 400) == [[870, 602.7108], [871, 602.2224]]


def test_clipping_polarity():
    z = np.array([[-4.0, 1.0, 2.0]])
    out, lo, hi = amplitude(z, Seismic(clip_percentile=100, reverse_polarity=True))
    np.testing.assert_array_equal(out, -z)
    assert (lo, hi) == (-4, 4)
    _, lo, hi = amplitude(z, Seismic(clip_mode="manual", vmin=-2, vmax=1))
    assert (lo, hi) == (-2, 1)
    with pytest.raises(ValueError):
        amplitude(z, Seismic(clip_mode="manual", vmin=2, vmax=1))


def test_custom_red_white_blue_colormap(cube):
    state = ViewState(
        section_number=12,
        seismic={"colormap": "red_white_blue"},
    )
    assert render(cube, {}, state, Settings(format="png")).startswith(b"\x89PNG")


@pytest.mark.parametrize(
    "fmt,magic", [("png", b"\x89PNG"), ("pdf", b"%PDF"), ("svg", b"<?xml")]
)
def test_export(cube, tmp_path, fmt, magic):
    p = tmp_path / "h.txt"
    p.write_text("12 30 205\n12 33 207\n12 38 209\n")
    state = ViewState(
        section_number=12,
        x_range=(31, 36),
        time_range=(202, 210),
        horizons=[
            HorizonStyle(
                id="h",
                name="h",
                marker={"visible": True, "shape": "diamond", "size": 5},
            )
        ],
    )
    data = render(cube, {"h": Horizon(p)}, state, Settings(format=fmt))
    assert data.startswith(magic)
    if fmt == "png":
        from PIL import Image

        im = Image.open(io.BytesIO(data))
        assert abs(im.width - 180 / 25.4 * 300) < 2
    if fmt == "svg":
        assert b"Inline 12" in data and b"TWT (ms)" in data


def test_api(cube):
    server.survey = cube
    server.horizons.clear()
    c = TestClient(server.app)
    catalog = c.get("/api/catalog")
    assert catalog.status_code == 200
    colors = catalog.json()["colormaps"]["red_white_blue"]
    assert len(colors) == 256
    assert colors[0][1] != colors[-1][1]
    assert c.post("/api/section", json={"section_number": 11}).status_code == 400
    assert (
        c.post(
            "/api/section",
            json={"section_number": 12, "seismic": {"clip_percentile": 101}},
        ).status_code
        == 422
    )
    r = c.post("/api/horizons", files=[("files", ("h.dat", b"12 30 205\n12 33 207"))])
    assert r.status_code == 200
    h = r.json()[0]
    s = c.post("/api/section", json={"section_number": 12}).json()
    assert s["horizons"][h["id"]] == [[30, 205], [33, 207]]
    r = c.post(
        "/api/export",
        json={
            "state": {"section_number": 12, "horizons": [h]},
            "settings": {"format": "pdf"},
        },
    )
    assert r.status_code == 200 and r.content.startswith(b"%PDF")
    assert c.delete("/api/horizons/" + h["id"]).status_code == 200
    assert not server.horizons
    with cube.path.open("rb") as f:
        r = c.post(
            "/api/segy",
            files={"file": ("sample.segy", f)},
            data={"ilbyte": 189, "xlbyte": 21},
        )
    assert r.status_code == 200 and r.json()["metadata"]["samples"] == 4

@pytest.mark.parametrize("ratio", [(2, 1), (1, 2), None])
def test_2d_export_box_ratio(cube, monkeypatch, ratio):
    from matplotlib.figure import Figure
    figures = []
    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig
    monkeypatch.setattr("backend.core.Figure", capture)
    state = ViewState(section_number=12, aspect_ratio_2d=ratio)
    assert render(cube, {}, state, Settings()).startswith(b"\x89PNG")
    fig = figures[0]
    ax = fig.axes[0]
    if ratio:
        bbox = ax.get_window_extent()
        assert bbox.width / bbox.height == pytest.approx(ratio[0] / ratio[1])
    assert ax.get_ylim() == (212, 200)
    assert ax.get_xlim() == (29.5, 38.5)
