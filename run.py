"""Start the built local SeisCanvas application."""

import os
import argparse
import tempfile
from pathlib import Path

os.environ.setdefault(
    "MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "seiscanvas-mpl")
)
import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Start SeisCanvas on the loopback interface.")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    uvicorn.run("backend.main:app", host="127.0.0.1", port=args.port)
