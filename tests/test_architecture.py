"""Protect dependency boundaries without imposing a directory-only architecture."""
import ast
from importlib.util import resolve_name
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def module_imports(path):
    name = '.'.join(path.relative_to(ROOT).with_suffix('').parts)
    package = name.rsplit('.', 1)[0]
    for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
        if isinstance(node, ast.Import):
            yield from (alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ''
            if node.level:
                module = resolve_name('.' * node.level + module, package)
            yield module
            yield from (module + '.' + alias.name for alias in node.names)


def test_backend_dependencies_remain_acyclic():
    files = {'.'.join(p.relative_to(ROOT).with_suffix('').parts): p
             for p in (ROOT / 'backend').rglob('*.py') if p.name != '__init__.py'}
    graph = {name: set(module_imports(path)) & files.keys() for name, path in files.items()}
    visited, active = set(), []

    def visit(name):
        assert name not in active, 'Circular dependency: ' + ' -> '.join([*active, name])
        if name in visited:
            return
        active.append(name)
        for dependency in graph[name]:
            visit(dependency)
        active.pop()
        visited.add(name)

    for name in graph:
        visit(name)


def test_scientific_data_and_numeric_modules_do_not_import_http_or_app_state():
    modules = ('geometry', 'regular_geometry', 'segy', 'preview', 'resample',
               'horizon', 'horizon_cache', 'horizon_display', 'trace_overlay',
               'section_service', 'scene', 'rendering', 'horizon_map')
    for name in modules:
        imports = set(module_imports(ROOT / 'backend' / (name + '.py')))
        assert not any(module == 'backend.main' or module.startswith(('fastapi', 'starlette', 'backend.api'))
                       for module in imports), f'{name} depends on the HTTP/application layer'


def test_http_adapters_never_import_the_application_entry_point():
    for path in (ROOT / 'backend' / 'api').glob('*.py'):
        assert 'backend.main' not in set(module_imports(path)), f'{path.name} imports application state'
