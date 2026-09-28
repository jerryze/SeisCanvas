from pathlib import Path
import io
import numpy as np
import pytest
import segyio
from fastapi.testclient import TestClient
from backend.core import Survey, Horizon, amplitude, get_cmap, horizon_preview, render
from backend.models import ViewState, Seismic, Settings, HorizonStyle
import backend.main as server


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


def test_import_skips_duplicate_coordinate_validation(cube):
    survey = Survey(cube.path, 189, 189)
    assert survey.count == cube.count


def test_import_skips_per_trace_time_validation(cube):
    with segyio.open(str(cube.path), 'r+', ignore_geometry=True) as f:
        f.header[1] = {109: 240, 117: 2000}
    survey = Survey(cube.path)
    assert survey.count == cube.count


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


def test_red_white_blue_matches_the_pos_zero_neg_reference():
    """Anchor stops sampled from the supplied Pos / 0 / Neg colorbar."""
    cmap = get_cmap("red_white_blue")
    rgb = lambda t: tuple(round(c * 255) for c in cmap(t)[:3])
    # Sampling goes through a 256 entry lookup table, so allow one level of
    # quantization on the anchors.
    close = lambda a, b: all(abs(x - y) <= 2 for x, y in zip(a, b))

    # Negative end is a deep, slightly desaturated blue; positive end a dark red.
    assert close(rgb(0.00), (0x23, 0x23, 0x8E))
    assert close(rgb(1.00), (0x8C, 0x00, 0x00))
    # Zero is white, with the curved shoulder on the way to blue.
    assert close(rgb(0.50), (0xFF, 0xFF, 0xFF))
    assert close(rgb(0.40), (0xB7, 0xCF, 0xD3))
    assert close(rgb(0.25), (0x7E, 0x8C, 0xB9))
    assert close(rgb(0.75), (0xCC, 0x7F, 0x7E))
    assert rgb(0.25)[2] > rgb(0.25)[0]  # blue side
    assert rgb(0.75)[0] > rgb(0.75)[2]  # red side
    # Diverging and monotone in luminance on both halves.
    for t in (0.00, 0.05, 0.10, 0.20, 0.30, 0.40):
        assert sum(rgb(t)) < sum(rgb(t + 0.05))
    for t in (0.55, 0.65, 0.75, 0.85, 0.90):
        assert sum(rgb(t)) > sum(rgb(t + 0.05))


def test_seismic_model_accepts_every_catalog_colormap():
    """models.Seismic must track core.CMAPS, or saved views stop loading."""
    from backend.core import CMAPS
    for name in CMAPS:
        assert Seismic(colormap=name).colormap == name
    with pytest.raises(ValueError):
        Seismic(colormap="not-a-colormap")


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
    monkeypatch.setattr("backend.rendering.Figure", capture)
    state = ViewState(section_number=12, aspect_ratio_2d=ratio)
    assert render(cube, {}, state, Settings()).startswith(b"\x89PNG")
    fig = figures[0]
    ax = fig.axes[0]
    if ratio:
        bbox = ax.get_window_extent()
        assert bbox.width / bbox.height == pytest.approx(ratio[0] / ratio[1])
    assert ax.get_ylim() == (212, 200)
    assert ax.get_xlim() == (29.5, 38.5)


def test_publication_font_defaults_and_fallback(cube, monkeypatch):
    import warnings
    from matplotlib.figure import Figure
    from matplotlib.font_manager import FontProperties, findfont
    from backend.core import font_family
    from backend.models import Scene3DSettings

    assert Settings().font == "Times New Roman"
    assert Scene3DSettings().font == "Times New Roman"
    assert font_family("Times New Roman") == ["Times New Roman", "DejaVu Serif"]
    assert font_family("Arial") == ["Arial", "DejaVu Sans"]
    assert font_family(None) == ["DejaVu Sans"]
    # A machine without the system face still resolves to the bundled serif.
    assert findfont(FontProperties(family=font_family("Missing Face Serif"))).endswith(
        "DejaVuSerif.ttf"
    )

    figures = []

    def capture(*args, **kwargs):
        figure = Figure(*args, **kwargs)
        figures.append(figure)
        return figure

    monkeypatch.setattr("backend.rendering.Figure", capture)
    with warnings.catch_warnings():
        warnings.filterwarnings("error", message=".*findfont.*")
        data = render(cube, {}, ViewState(section_number=12), Settings())
    assert data.startswith(b"\x89PNG")
    ax = figures[0].axes[0]
    assert ax.title.get_fontfamily() == ["Times New Roman", "DejaVu Serif"]
    assert ax.xaxis.label.get_fontfamily() == ["Times New Roman", "DejaVu Serif"]


def test_section_export_without_axes(cube, monkeypatch):
    from matplotlib.figure import Figure
    figures = []
    def capture(*args, **kwargs):
        fig = Figure(*args, **kwargs)
        figures.append(fig)
        return fig
    monkeypatch.setattr('backend.rendering.Figure', capture)
    render(cube, {}, ViewState(section_number=12), Settings(show_axes=False, show_title=True))
    assert not figures[0].axes[0].axison
    assert figures[0].axes[0].get_title() == 'Inline 12'


def test_array_cache_byte_budget():
    from backend.core import ArrayCache
    cache = ArrayCache(max_bytes=32)
    cache['first'] = np.zeros(6, dtype=np.float32)
    cache['second'] = np.zeros(4, dtype=np.float32)
    assert list(cache) == ['second']
    cache['too_large'] = np.zeros(100, dtype=np.float32)
    assert 'too_large' not in cache
    cache['tuple'] = (np.zeros(2, dtype=np.float32), np.zeros(2, dtype=np.float32))
    assert sum(cache.size(v) for v in cache.values()) <= 32


def test_direct_local_segy_preserves_source(cube):
    old_survey, old_horizons = server.survey, server.horizons.copy()
    try:
        client = TestClient(server.app)
        response = client.post('/api/segy/local', json={'path': str(cube.path), 'ilbyte':189, 'xlbyte':21})
        assert response.status_code == 200
        assert server.survey.path == cube.path
        assert response.json()['metadata']['traces'] == cube.count
        assert cube.path.exists()
        response = client.post('/api/segy/local', json={'path':'missing.segy'})
        assert response.status_code == 400
        assert server.survey.path == cube.path
    finally:
        server.survey = old_survey
        server.horizons.clear()
        server.horizons.update(old_horizons)


def test_native_segy_picker_open_and_cancel(cube, monkeypatch):
    old_survey, old_horizons = server.survey, server.horizons.copy()
    client = TestClient(server.app)
    try:
        monkeypatch.setattr(server, 'choose_segy', lambda: str(cube.path))
        result = client.post('/api/segy/pick', json={'ilbyte':189, 'xlbyte':21})
        assert result.status_code == 200
        assert server.survey.path == cube.path
        current = server.survey
        monkeypatch.setattr(server, 'choose_segy', lambda: None)
        assert client.post('/api/segy/pick', json={}).json() == {'cancelled': True}
        assert server.survey is current and cube.path.exists()
    finally:
        server.survey = old_survey
        server.horizons.clear()
        server.horizons.update(old_horizons)


def test_segy_progress_reports_ordered_stages(cube):
    events = []
    Survey(cube.path, progress=lambda percent, stage: events.append((percent, stage)))
    assert [p for p, _ in events] == sorted(p for p, _ in events)
    assert events[-1][0] == 98
    assert any('扫描道头' in stage or '缓存' in stage for _, stage in events)
    assert any('索引' in stage for _, stage in events)


def test_geometry_cache_hit_and_invalidation(cube, tmp_path, monkeypatch):
    import backend.geometry as geometry
    import backend.segy as segy
    import os
    monkeypatch.setattr(geometry, 'CACHE_DIR', tmp_path / 'cache')
    first = Survey(cube.path)
    assert not first.geometry_cached and first.geometry_cache_saved
    assert first.trace_lookup.shape == (2, 3)
    original = segy.build_geometry
    def no_scan(*args):
        raise AssertionError('Cache hit must not scan headers')
    monkeypatch.setattr(segy, 'build_geometry', no_scan)
    second = Survey(cube.path)
    assert second.geometry_cached
    np.testing.assert_array_equal(second.section('inline', 12)[2], first.section('inline', 12)[2])
    monkeypatch.setattr(segy, 'build_geometry', original)
    stat = cube.path.stat()
    os.utime(cube.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1000000))
    assert not Survey(cube.path).geometry_cached
    assert not Survey(cube.path, 189, 193).geometry_cached


def test_geometry_scan_only_reads_trace_headers():
    from backend.geometry import build_geometry
    class HeaderOnly:
        tracecount = 4
        header = [{189: 10, 21: 30}, {189: 10, 21: 31}, {189: 11, 21: 30}, {189: 11, 21: 31}]
        @property
        def trace(self):
            raise AssertionError('No amplitudes during import')
    result = build_geometry(HeaderOnly(), 189, 21, lambda *args: None)
    np.testing.assert_array_equal(result['lookup'], [[0, 1], [2, 3]])
    assert result['ils'].dtype == np.int32


@pytest.mark.parametrize('outer', [0, 1])
@pytest.mark.parametrize('reverse', [False, True])
def test_regular_geometry_probes_and_lookup(outer, reverse):
    from backend.geometry import build_regular_geometry
    il = list(range(100, 140, 2)); xl = list(range(300, 420, 3))
    if reverse:
        il.reverse(); xl.reverse()
    pairs = [(i, x) for i in il for x in xl] if outer == 0 else [(i, x) for x in xl for i in il]
    reads = []
    class Headers:
        def __getitem__(self, index):
            reads.append(index)
            return {189:pairs[index][0], 21:pairs[index][1]}
    class File:
        tracecount = len(pairs)
        header = Headers()
    result = build_regular_geometry(File(), 189, 21, lambda *args: None)
    assert len(reads) <= 12
    for r, i in enumerate(sorted(il)):
        for c, x in enumerate(sorted(xl)):
            assert pairs[result['lookup'][r,c]] == (i,x)


def test_regular_geometry_rejects_inconsistent_boundary():
    from backend.geometry import build_regular_geometry
    class File:
        tracecount = 4
        header = [{189:1,21:1},{189:1,21:2},{189:2,21:2},{189:2,21:1}]
    with pytest.raises(ValueError, match='Auto'):
        build_regular_geometry(File(), 189, 21, lambda *args: None)


def test_formula_geometry_reads_and_small_cache(cube, tmp_path, monkeypatch):
    import backend.geometry as geometry
    import backend.segy as segy
    from backend.scene import timeslice
    monkeypatch.setattr(geometry, 'CACHE_DIR', tmp_path/'formula-cache')
    with segyio.open(str(cube.path), 'r+', ignore_geometry=True) as f:
        for i in [2,5]:
            f.header[i] = {21:36}
    expected = Survey(cube.path)
    fast = Survey(cube.path, geometry_mode='regular')
    assert fast.regular.inner_count == 3
    assert fast.regular.outer_count == 2
    assert not hasattr(fast, 'ils') and not hasattr(fast, 'maps')
    assert fast.trace_lookup is None
    assert int(fast.regular.trace_id(12,36)) == 5
    assert int(fast.regular.byte_offset(12,36)) == 3600+5*(240+4*4)
    for mode, n in [('inline',12),('crossline',33)]:
        np.testing.assert_array_equal(fast.section(mode,n)[2], expected.section(mode,n)[2])
    np.testing.assert_array_equal(timeslice(fast,204)[1],timeslice(expected,204)[1])
    assert all(a.ndim == 0 for a in fast.regular.parameters().values())
    def no_probe(*args):
        raise AssertionError('Cached formula must skip probing')
    monkeypatch.setattr(segy, 'probe_regular', no_probe)
    assert Survey(cube.path, geometry_mode='regular').geometry_cached
