"""Package the current source and prebuilt web app, excluding user data."""
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path
import hashlib
import io
import subprocess
import tarfile

root = Path(__file__).resolve().parents[1]
if not (root / "frontend/dist/index.html").is_file():
    raise SystemExit("Build frontend first: npm --prefix frontend run build")
name = "SeisCanvas-linux-" + datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
out = root / "outputs/releases"
out.mkdir(parents=True, exist_ok=True)
files = set()
for folder in ("backend", "frontend/src", "frontend/public", "frontend/dist", "frontend/tests", "tests", "benchmarks", "assets", "deploy", ".github"):
    for path in (root / folder).rglob("*"):
        if path.is_file() and not path.is_symlink() and "__pycache__" not in path.parts and path.name != ".DS_Store":
            files.add(path.relative_to(root))
for pattern in ("*.md", "requirements*.txt", "run.py", "frontend/*.json", "frontend/*.ts", "frontend/index.html"):
    files.update(path.relative_to(root) for path in root.glob(pattern) if path.is_file())
checksums = "".join(f"{hashlib.sha256((root / path).read_bytes()).hexdigest()}  {path.as_posix()}\n" for path in sorted(files))
revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
info = f"{name}\nBase Git commit: {revision}\nIncludes current working-tree changes and prebuilt frontend.\nExcludes user data, saved projects, outputs, caches, node_modules and virtual environments.\n"
archive = out / f"{name}.tar.gz"
with tarfile.open(archive, "w:gz") as tar:
    for path in sorted(files):
        tar.add(root / path, arcname=f"{name}/{path.as_posix()}", recursive=False)
    for filename, content in (("SHA256SUMS", checksums), ("BUILD_INFO.txt", info)):
        blob = content.encode("utf-8")
        entry = tarfile.TarInfo(f"{name}/{filename}")
        entry.size = len(blob)
        entry.mode = 0o644
        tar.addfile(entry, io.BytesIO(blob))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(archive.suffix + ".sha256").write_text(f"{digest}  {archive.name}\n")
print(f"{archive}\n{archive.stat().st_size / 1024 / 1024:.2f} MiB; {len(files)} files\nSHA256 {digest}")
