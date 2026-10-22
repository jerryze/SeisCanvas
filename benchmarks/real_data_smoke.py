"""Exercise real SEG-Y/horizon HTTP workflows using a new, isolated QA project.

Requires explicit input paths. Never uses the user's saved application state.
Keep --state-dir available to inspect this project with a separate local server.
"""
import argparse
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from time import perf_counter
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--segy', type=Path, required=True)
    parser.add_argument('--horizon', type=Path, action='append', required=True)
    parser.add_argument('--state-dir', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    root = args.state_dir or Path(tempfile.mkdtemp(prefix='seiscanvas-real-qa-'))
    if root.exists() and any(root.iterdir()):
        parser.error('--state-dir must be empty or absent; existing projects are never reused')
    root.mkdir(parents=True, exist_ok=True)
    os.environ['SEISCANVAS_STATE_DIR'] = str(root.resolve())
    os.environ.setdefault('MPLCONFIGDIR', str(root / 'matplotlib'))

    from fastapi.testclient import TestClient
    from backend import main as server

    paths = [args.segy.resolve(), *(p.resolve() for p in args.horizon)]
    signatures = [(p.stat().st_size, p.stat().st_mtime_ns) for p in paths]
    timings, artifacts, queue_ids = [], [], []
    with TestClient(server.app) as client:
        def call(method, path, **kwargs):
            document = server.project.read()
            headers = {'X-SeisCanvas-Project': document['id'] if document else 'none',
                       'X-SeisCanvas-Epoch': server.project.epoch}
            if document:
                headers['X-SeisCanvas-Revision'] = str(document['revision'])
            start = perf_counter()
            response = client.request(method, path, headers=headers, **kwargs)
            timings.append({'method': method, 'path': path, 'seconds': perf_counter() - start,
                            'status': response.status_code, 'bytes': len(response.content)})
            assert response.status_code == 200, (path, response.status_code, response.text[:800])
            return response

        loaded = call('POST', '/api/segy/local', json={'path': str(paths[0])}).json()
        meta = loaded['metadata']
        call('PATCH', '/api/projects/' + loaded['project_id'], json={'name': 'SeisCanvas 重构验证'})
        horizons = []
        for path in paths[1:]:
            with path.open('rb') as source:
                horizons.extend(call('POST', '/api/horizons', files={'files': (path.name, source)}).json())
        inline = meta['inlines'][len(meta['inlines']) // 2]
        crossline = meta['crosslines'][len(meta['crosslines']) // 2]
        time = sum(meta['time_range']) / 2
        seismic = {'wiggle': True, 'variable_area': True, 'background_interpolation': True}
        view = {'view_type': 'inline', 'section_number': inline, 'seismic': seismic, 'horizons': horizons,
                'trace_viewport_width': 700, 'trace_viewport_height': 450}
        section = call('POST', '/api/section', json={**view, 'target_width': 700, 'target_height': 450}).json()
        assert section['trace_overlay'] and section['interpolation'] == 'sinc8'
        call('POST', '/api/section', json={**view, 'view_type': 'crossline', 'section_number': crossline,
                                          'target_width': 700, 'target_height': 450})
        probe = call('POST', '/api/sample', json={'kind': 'inline', 'position': inline,
                                                 'crossline': crossline, 'time': time}).json()
        assert probe['source'] == 'original' and probe['amplitude'] is not None
        scene = call('POST', '/api/scene', json={'view_mode': '3d', 'seismic': seismic,
            'scene': {'quality': 128}, 'horizons': horizons,
            'slices': {kind: [{'id': kind, 'position': position}]
                       for kind, position in [('inline', inline), ('crossline', crossline), ('time', time)]}}).json()
        assert len(scene['slices']) == 3 and len(scene['horizons']) == len(horizons)

        state = {'horizon': horizons[0]['id'], 'display': 'filled'}
        for color_by in ['twt', 'amplitude']:
            call('POST', '/api/horizon-map', json={**state, 'color_by': color_by})
        if len(horizons) > 1:
            difference = call('POST', '/api/horizon-map', json={**state, 'color_by': 'difference',
                'difference_reference': horizons[0]['id'], 'difference_comparison': horizons[1]['id']}).json()
            assert difference['statistics']['count'] > 0
        a = [inline, meta['crosslines'][len(meta['crosslines']) // 4]]
        b = [inline, meta['crosslines'][3 * len(meta['crosslines']) // 4]]
        profile = call('POST', '/api/horizon-map/profile', json={'state': state, 'a': a, 'b': b,
            'target_width': 700, 'target_height': 450, 'seismic': seismic}).json()
        assert profile['amplitude'] and profile['trace_overlay']
        for kind in ['2d', 'map', 'profile']:
            for fmt in ['png', 'svg', 'pdf']:
                request = {'kind': kind, 'state': view if kind == '2d' else state,
                           'settings': {'format': fmt, 'canvas': 'fit', 'long_edge': 600}}
                if kind == 'profile':
                    request.update(a=a, b=b, seismic=seismic, horizons=horizons)
                item = call('POST', '/api/export/queue', json=request).json()
                queue_ids.append(item['id'])
                response = call('GET', f"/api/export/queue/{item['id']}/file?project_id={loaded['project_id']}")
                assert response.content.startswith({'png': b'\x89PNG', 'svg': b'<?xml', 'pdf': b'%PDF'}[fmt]) \
                    or fmt == 'svg' and b'<svg' in response.content[:100]
                artifacts.append({'kind': kind, 'format': fmt, 'bytes': len(response.content)})
                if args.output:
                    destination = args.output.parent / f'{kind}.{fmt}'
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(response.content)
        archive = call('POST', '/api/export/archive', json={'item_ids': queue_ids})
        with ZipFile(io.BytesIO(archive.content)) as zipped:
            manifest = json.loads(zipped.read('export_manifest.json'))
            assert manifest['figure_count'] == 9
        assert not list(server.export_queue.session().folder.glob('_archive_*.zip'))
        # Re-read all original scientific files through the project's restore path.
        server.survey, server.horizons, server.restored_project = None, {}, None
        restored = call('GET', '/api/workspace').json()
        stable_metadata = lambda value: {key: item for key, item in value.items()
                                         if key not in {'geometry_cached', 'geometry_cache_saved'}}
        assert not restored['issues'] and stable_metadata(restored['metadata']) == stable_metadata(meta)
        assert len(restored['horizons']) == len(horizons)
        assert call('GET', '/api/export/queue').json()['count'] == 9
    assert signatures == [(p.stat().st_size, p.stat().st_mtime_ns) for p in paths]
    result = {'source_file_bytes': signatures[0][0], 'metadata': meta, 'horizons': len(horizons),
              'state_dir': str(root.resolve()), 'checks': timings, 'artifacts': artifacts,
              'archive_figures': 9, 'restore_passed': True, 'source_files_unchanged': True}
    encoded = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(encoded, end='')


if __name__ == '__main__':
    main()
