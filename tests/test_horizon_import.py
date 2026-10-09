from types import SimpleNamespace
import ast
import pytest
from fastapi.testclient import TestClient
import backend.main as server
import backend.file_picker as picker


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
    monkeypatch.setattr(picker.sys, 'platform', platform)
    commands = []
    def run(command, **kwargs):
        commands.append(command)
        return SimpleNamespace(returncode=0, stdout='/tmp/first file.txt\n/tmp/second.dat\n')
    monkeypatch.setattr(picker.subprocess, 'run', run)
    assert picker.choose_segy('Horizon', multiple=True) == ['/tmp/first file.txt', '/tmp/second.dat']
    script = commands[0][-1]
    if platform == 'linux':
        ast.parse(script)
        assert 'askopenfilenames' in script
    elif platform == 'darwin':
        assert 'with multiple selections allowed' in script
    else:
        assert '$dialog.Multiselect = $true' in script
