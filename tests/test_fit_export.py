"""Final content bounds, native-data resampling and immutable queue exports."""
import io
import re
import xml.etree.ElementTree as ET
import numpy as np
import pytest
from PIL import Image
from backend.models import Settings, ViewState, HorizonMapState
from backend.rendering import render
from backend.horizon import Horizon
from backend.horizon_map import render_map
from backend import resample


def dimensions(data, fmt):
    if fmt == 'png':
        with Image.open(io.BytesIO(data)) as image:
            return image.size
    if fmt == 'svg':
        return tuple(map(float, ET.fromstring(data).attrib['viewBox'].split()[2:]))
    match = re.search(rb'/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)', data)
    return tuple(map(float, match.groups()))


def test_section_content_fit_all_formats_and_sampling(cube, monkeypatch, tmp_path):
    calls = []
    original = resample.resample
    def sample(data, width, height, method):
        calls.append((data.shape, width, height))
        return original(data, width, height, method)
    monkeypatch.setattr(resample, 'resample', sample)
    state = ViewState(section_number=10, aspect_ratio_2d=(3, 1))
    ratios = []
    for fmt in ['png', 'svg', 'pdf']:
        settings = Settings(canvas='fit', long_edge=1200, format=fmt, background='transparent')
        data = render(cube, {}, state, settings)
        (tmp_path / f'section.{fmt}').write_bytes(data)
        w, h = dimensions(data, fmt)
        ratios.append(w/h)
        if fmt == 'png':
            assert w == 1200
            image = np.array(Image.open(io.BytesIO(data)).convert('RGBA'))
            assert (image[0, :, 3] == 0).all()
            assert (image[-1, :, 3] == 0).all()
            assert (image[:, 0, 3] == 0).all()
            assert (image[:, -1, 3] == 0).all()
            assert image[:, :, 3].max() == 255
        elif fmt == 'svg':
            assert b'<text' in data and b'<image' in data
    assert max(ratios) - min(ratios) < .01
    assert all(shape == (4, 3) and w > 900 and h > 250 for shape, w, h in calls)


def test_map_portrait_colorbar_fits_and_white_background(cube, tmp_path):
    p = tmp_path / 'map.txt'
    p.write_text('\n'.join(f'{il} {xl} {200+il+xl}' for il in range(10, 31) for xl in range(30, 34)))
    h = Horizon(p)
    state = HorizonMapState(horizon='h', colorbar=True)
    settings = Settings(canvas='fit', long_edge=900)
    data = render_map(cube, h, state, settings, {'h': h})
    image = Image.open(io.BytesIO(data)).convert('RGBA')
    assert image.height == 900 and image.width < image.height
    assert image.getpixel((0, 0)) == (255, 255, 255, 255)
    # Long Edge does not impose a square or browser-shaped plot.
    svg = render_map(cube, h, state, settings.model_copy(update={'format':'svg'}), {'h': h})
    w, height = dimensions(svg, 'svg')
    assert abs(w/height - image.width/image.height) < .01
    assert b'<text' in svg


def test_default_long_edge_and_legacy_compatibility(cube):
    assert Settings().canvas == 'fit'
    assert Settings(width=180, height=100).canvas == 'fixed'
    result = render(cube, {}, ViewState(section_number=10), Settings())
    assert max(dimensions(result, 'png')) == 3000


@pytest.mark.parametrize('fmt', ['png', 'svg', 'pdf'])
def test_fit_queue_metadata_and_archive_do_not_render(client, monkeypatch, fmt):
    import zipfile
    import backend.export_service as service
    response = client.post('/api/export/queue', json={
        'kind': '2d', 'state': {'section_number': 10},
        'settings': {'canvas': 'fit', 'long_edge': 800, 'format': fmt},
    })
    assert response.status_code == 200, response.text
    item = response.json()
    assert max(item['pixel_size']) == 800
    assert f"{item['pixel_size'][0]}x{item['pixel_size'][1]}px" in item['filename']
    from pathlib import Path
    saved = Path(item['temporary_path']).read_bytes()
    def fail(*a, **kw):
        raise AssertionError('Archive must not re-render')
    monkeypatch.setattr(service, 'render', fail)
    archive = client.post('/api/export/archive')
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
        figure = next(n for n in z.namelist() if n.endswith('.' + fmt))
        assert z.read(figure) == saved


@pytest.mark.parametrize('fmt', ['png', 'svg', 'pdf'])
def test_3d_fit_queue_preserves_final_capture_dimensions(client, fmt):
    import base64
    raw = io.BytesIO()
    Image.new('RGBA', (800, 640), (255, 255, 255, 0)).save(raw, format='PNG')
    response = client.post('/api/export/queue', json={
        'kind': '3d', 'png': 'data:image/png;base64,' + base64.b64encode(raw.getvalue()).decode(),
        'format': fmt, 'width_px': 800, 'height_px': 640, 'scale': 1, 'render_dpi': 384,
        'settings': {'canvas': 'fit', 'long_edge': 800, 'background': 'transparent'},
        'state': {'view_mode': '3d'},
    })
    assert response.status_code == 200, response.text
    item = response.json()
    assert item['pixel_size'] == [800, 640]
    assert abs(item['width_mm'] - 800 / 384 * 25.4) < .01
    assert abs(item['height_mm'] - 640 / 384 * 25.4) < .01


def test_profile_legend_and_colorbar_fit(cube, horizon):
    from backend.horizon_map import render_profile
    state = HorizonMapState(horizon='h', colorbar=True)
    data, info = render_profile(cube, state, {'h': horizon}, (10, 30), (12, 33),
                                Settings(canvas='fit', long_edge=900, format='svg'))
    assert b'<text' in data and b'Amplitude' in data and b'A' in data
    assert dimensions(data, 'svg')[0] > 0
    assert info['curves']


def test_3d_publication_sampling_uses_final_pixel_request(cube, monkeypatch):
    from backend.models import ViewState3D
    from backend import scene
    original = scene.slice_data
    calls = []
    def sampled(survey, kind, position, maximum, interpolation):
        calls.append(maximum)
        return original(survey, kind, position, maximum, interpolation)
    monkeypatch.setattr(scene, 'slice_data', sampled)
    scene.scene_data(cube, {}, ViewState3D(
        scene={'export_long_edge': 1500},
        slices={'inline': [{'id':'a','position':10}]},
    ))
    assert calls == [1500]


def test_png_metadata_keeps_renderer_compressed_pixels():
    import base64
    import struct
    from backend.models import SceneExportRequest
    from backend.export3d import decode_scene_png, encode_scene
    stream = io.BytesIO()
    Image.new('RGBA', (800, 640), (20, 40, 60, 128)).save(stream, format='PNG', dpi=(96,96))
    source = stream.getvalue()
    req = SceneExportRequest(png='data:image/png;base64,'+base64.b64encode(source).decode(),
                             width=800, height=640, scale=1, format='png', dpi=384)
    raw, pixels, size = decode_scene_png(req)
    assert pixels is None  # PNG packaging does not decode the RGBA array.
    output = encode_scene(req, raw, pixels, size)
    def chunks(data, kind):
        offset = 8
        found = []
        while offset < len(data):
            n = struct.unpack('>I', data[offset:offset+4])[0]
            if data[offset+4:offset+8] == kind:
                found.append(data[offset+8:offset+8+n])
            offset += n+12
        return found
    assert chunks(output, b'IDAT') == chunks(source, b'IDAT')
    assert len(chunks(output, b'pHYs')) == 1
    im = Image.open(io.BytesIO(output))
    assert abs(im.info['dpi'][0]-384) < .01
    assert im.getpixel((0,0)) == (20,40,60,128)
