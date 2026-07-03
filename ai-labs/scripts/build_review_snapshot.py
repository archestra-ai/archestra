# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Build the shared backend-source snapshot for the code-review tasks.

Both review tasks (run-command-persistence, file-upload-persistence) seed the SAME byte-identical
tree so that which files are present can never reveal which task is which. The snapshot is the
backend persistence neighbourhood as of 6698224a (the commit right before the NUL-byte fix
050f17e94): the bug under review is fully present, the bytea-safe sibling is present, and all 112
DB schemas are included so the reviewer must locate the relevant one rather than being handed it.

History is dropped entirely (`git archive` emits a bare tree, no .git), so the fix commit is
structurally unreachable. Deterministic: fixed commit + sorted file list + gzip without mtime.

Run:  uv run ai-labs/scripts/build_review_snapshot.py
"""

from __future__ import annotations

import gzip
import subprocess
import tarfile
from io import BytesIO
from pathlib import Path

BASE = "6698224a09acf1a2a199a73300eb30fe6e327180"
PREFIX = "platform/backend/src"
TREES = [f"{PREFIX}/database/schemas", f"{PREFIX}/skills-sandbox"]
FILES = [
    f"{PREFIX}/models/skill-sandbox.ts",
    f"{PREFIX}/models/skill-sandbox-file.ts",
    f"{PREFIX}/models/skill-sandbox-replay-event.ts",
    f"{PREFIX}/archestra-mcp-server/sandbox.ts",
]
TASKS = ["review-run-command-persistence", "review-file-upload-persistence"]
REPO = Path(__file__).resolve().parents[2]


def _git(*args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(REPO), *args], capture_output=True, check=True
    ).stdout


def _source_paths() -> list[str]:
    paths = list(FILES)
    for tree in TREES:
        listed = (
            _git("ls-tree", "-r", "--name-only", BASE, "--", tree).decode().splitlines()
        )
        paths.extend(
            p for p in listed if not p.endswith((".test.ts", ".test.tsx", ".spec.ts"))
        )
    return sorted(set(paths))


def _build_targz() -> bytes:
    raw = BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for path in _source_paths():
            blob = _git("show", f"{BASE}:{path}")
            info = tarfile.TarInfo(name=path)
            info.size = len(blob)
            info.mtime = 0
            info.mode = 0o644
            tar.addfile(info, BytesIO(blob))
    out = BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()


def main() -> None:
    targz = _build_targz()
    for task in TASKS:
        dest = (
            REPO / "ai-labs" / "tasks" / task / "inputs" / "backend-src.tar.gz"
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(targz)
        print(f"wrote {dest.relative_to(REPO)} ({len(targz)} bytes)")


if __name__ == "__main__":
    main()
