from types import SimpleNamespace
import ast
import pytest
from fastapi.testclient import TestClient
import backend.main as server
import backend.file_picker as picker
from backend.horizon import Horizon, horizon_preview


def test_batch_import_and_rename(tmp_path, monkeypatch):
    monkeypatch.setattr(server, 'horizons', {})
    monkeypatch.setattr(server, 'horizon_selections', {})
    paths = [tmp_path / 'first.txt', tmp_path / 'second.dat']
    for path in paths:
        path.write_text('time inline xline\n200 10 30\n204 12 33\n')
    monkeypatch.setattr(server, 'choose_segy', lambda *a, **kw: paths)
    client = TestClient(server.app)
    preview = client.post('/api/horizons/pick').json()
    assert preview['filenames'] == ['first.txt', 'second.dat']
    req = dict(token=preview['token'], inline_column=1, xline_column=2, time_column=0)
    paths[1].write_text('invalid\n')
    response = client.post('/api/horizons/local', json=req)
    assert response.status_code == 400
    assert 'second' in response.text
    assert not server.horizons
    paths[1].write_text('200 10 30\n204 12 33\n')
    response = client.post('/api/horizons/local', json=req)
    assert response.status_code == 200
    imported = response.json()
    assert [h['name'] for h in imported] == ['first', 'second']
    key = imported[0]['id']
    assert server.horizons[key].data.tolist() == [[10, 30, 200], [12, 33, 204]]
    response = client.patch(f'/api/horizons/{key}', json={'name': '  新层位  '})
    assert response.json()['name'] == server.horizons[key].name == '新层位'
    assert client.patch(f'/api/horizons/{key}', json={'name': '  '}).status_code == 400
    assert client.patch('/api/horizons/missing', json={'name': '名称'}).status_code == 404
    assert client.post('/api/horizons/local', json=req).status_code == 400


@pytest.mark.parametrize('platform', ['darwin', 'win32', 'linux'])
def test_multi_picker(platform, monkeypatch):
    monkeypatch.setattr(picker, 'server_path_mode', lambda: False)
    monkeypatch.setattr(picker.sys, 'platform', platform)
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(returncode=0, stdout='/tmp/first file.txt\n/tmp/second.dat\n')
    monkeypatch.setattr(picker.subprocess, 'run', run)
    assert picker.choose_segy('Horizon', multiple=True) == ['/tmp/first file.txt', '/tmp/second.dat']
    script = commands[0][-1]
    assert '*.txt' not in script and '*.dat' not in script
    if platform == 'linux':
        ast.parse(script)
        assert 'askopenfilenames' in script
    elif platform == 'darwin':
        assert 'with multiple selections allowed' in script
    else:
        assert '$dialog.Multiselect = $true' in script


@pytest.mark.parametrize('filename', ['picks', 'picks.xyz', 'picks.csv', 'picks.TSV', 'picks.asc', 'picks.custom'])
def test_any_suffix_through_preview_upload_and_server_path(tmp_path, filename):
    content = b'time,inline,xline\n200.125,10,30\n204.5,12,33\n'
    path = tmp_path / filename
    path.write_bytes(content)
    client = TestClient(server.app)
    preview = client.post('/api/horizons/preview', files={'file': (filename, content, 'application/octet-stream')})
    assert preview.status_code == 200, preview.text
    assert preview.json()['suggestions'] == {'inline': 1, 'xline': 2, 'time': 0}
    uploaded = client.post('/api/horizons', files=[('files', (filename, content))],
                           data={'inline_column': 1, 'xline_column': 2, 'time_column': 0})
    assert uploaded.status_code == 200, uploaded.text
    picked = client.post('/api/horizons/pick', json={'paths': [str(path)]})
    assert picked.status_code == 200, picked.text
    imported = client.post('/api/horizons/local', json={'token': picked.json()['token'],
        'inline_column': 1, 'xline_column': 2, 'time_column': 0})
    assert imported.status_code == 200, imported.text
    for row in uploaded.json() + imported.json():
        assert server.horizons[row['id']].data.tolist() == [[10, 30, 200.125], [12, 33, 204.5]]


@pytest.mark.parametrize('encoding', ['utf-8-sig', 'utf-16', 'utf-32', 'gb18030'])
@pytest.mark.parametrize('delimiter', [' ', '\t', ',', ';', '|'])
def test_preview_and_import_share_text_decoding(tmp_path, encoding, delimiter):
    path = tmp_path / '层位'
    text = '\n'.join(delimiter.join(row) for row in [
        ['name', 'inline', 'xline', 'time'], ['测试层', '10', '30', '200.125'], ['测试层', '12', '33', '2.045e2']])
    path.write_bytes(text.encode(encoding))
    preview = horizon_preview(path)
    assert preview['suggestions'] == {'inline': 1, 'xline': 2, 'time': 3}
    assert preview['rows'][0][0] == '测试层'
    assert Horizon(path, columns=(1, 2, 3)).data.tolist() == [[10, 30, 200.125], [12, 33, 204.5]]


def test_csv_quotes_and_empty_cells_do_not_shift_mapping(tmp_path):
    path = tmp_path / 'picks.csv'
    path.write_text('name,inline,xline,time,note\n"A,B",10,30,200,\n"C,D",12,33,204,"a;b"\n')
    assert horizon_preview(path)['rows'][0] == ['A,B', '10', '30', '200', '']
    assert Horizon(path, columns=(1, 2, 3)).data.tolist() == [[10, 30, 200], [12, 33, 204]]
    path.write_text('inline,xline,time\n10,30,200\n12,,204\n')
    with pytest.raises(ValueError, match='line 3'):
        Horizon(path)


def test_binary_is_rejected_by_content_and_batch_is_atomic(tmp_path):
    client = TestClient(server.app)
    binary = b'10 30 200\n\x00\x01not text'
    path = tmp_path / 'binary.txt'
    path.write_bytes(binary)
    assert client.post('/api/horizons/pick', json={'paths': [str(path)]}).status_code == 400
    assert client.post('/api/horizons/preview', files={'file': ('binary.txt', binary)}).status_code == 400
    result = client.post('/api/horizons', files=[('files', ('valid', b'10 30 200\n')),
                                              ('files', ('binary.txt', binary))])
    assert result.status_code == 400
    assert not server.horizons
