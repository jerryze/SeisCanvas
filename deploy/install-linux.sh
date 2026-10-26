#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python_bin="${PYTHON_BIN:-python3}"
"$python_bin" -c 'import sys; assert sys.version_info >= (3, 10), "Python 3.10+ required (3.12 recommended)"'
"$python_bin" -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
test -f frontend/dist/index.html || { echo 'Missing frontend/dist: build with npm ci && npm run build in frontend/ first.'; exit 1; }
echo 'Installed. Start with: bash deploy/start-linux.sh'
