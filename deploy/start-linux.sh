#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
test -x .venv/bin/python || { echo 'Run bash deploy/install-linux.sh first.'; exit 1; }
test -f frontend/dist/index.html || { echo 'Missing frontend/dist/index.html'; exit 1; }
export SEISCANVAS_REMOTE=1
export MPLBACKEND=Agg
exec .venv/bin/python run.py --port "${SEISCANVAS_PORT:-8000}"
