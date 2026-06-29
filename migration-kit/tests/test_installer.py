"""tests for the installer.

write_kit (the security boundary: path-safety, allowlist, clobber/atomicity) is pure and tested
directly. fetch_kit_files (the thin contents-API glue) is tested against a REAL local http.server --
no network, no mocks -- to confirm it pulls only the runtime allowlist and pins the response host.
"""
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from install import InstallError, fetch_kit_files, write_kit

# --- write_kit: the path-safety / clobber boundary ------------------------------------------------

def test_writes_allowlist_as_siblings(tmp_path: Path) -> None:
    dest = tmp_path / "skill"
    written = write_kit([
        ("SKILL.md", b"---\nname: migrate-to-archestra\n---\n"),
        ("scripts/discover.py", b"print('hi')\n"),
        ("references/install.md", b"# install\n"),
    ], dest, force=False)
    assert (dest / "SKILL.md").exists()
    assert (dest / "scripts" / "discover.py").read_text() == "print('hi')\n"
    assert (dest / "references" / "install.md").exists()
    assert sorted(p.name for p in written) == ["SKILL.md", "discover.py", "install.md"]


@pytest.mark.parametrize("rel", [
    "scripts/../../../../etc/passwd",  # traversal under an allowlisted prefix
    "scripts/./../../evil",            # per-component evasion ('.' then '..')
    "/etc/passwd",                     # absolute
    "scripts\\..\\..\\evil",           # backslash (Windows separator)
])
def test_unsafe_paths_are_rejected(tmp_path: Path, rel: str) -> None:
    with pytest.raises(InstallError, match="unsafe|escaping"):
        write_kit([(rel, b"pwned")], tmp_path / "skill", force=False)


def test_path_outside_allowlist_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(InstallError, match="allowlist"):
        write_kit([("tests/test_x.py", b"x")], tmp_path / "skill", force=False)


def test_destination_symlink_is_rejected(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    dest = tmp_path / "skill"
    dest.symlink_to(real)
    with pytest.raises(InstallError, match="symlink"):
        write_kit([("SKILL.md", b"x")], dest, force=True)


def test_file_destination_is_rejected(tmp_path: Path) -> None:
    dest = tmp_path / "skill"
    dest.write_text("i am a file, not a dir")
    with pytest.raises(InstallError, match="not a directory"):
        write_kit([("SKILL.md", b"x")], dest, force=True)


def test_nonempty_destination_requires_force(tmp_path: Path) -> None:
    dest = tmp_path / "skill"
    dest.mkdir()
    (dest / "stale").write_text("old")
    with pytest.raises(InstallError, match="not empty"):
        write_kit([("SKILL.md", b"new")], dest, force=False)
    write_kit([("SKILL.md", b"new")], dest, force=True)
    assert (dest / "SKILL.md").read_text() == "new"


def test_force_removes_stale_managed_files(tmp_path: Path) -> None:
    dest = tmp_path / "skill"
    (dest / "scripts").mkdir(parents=True)
    (dest / "scripts" / "old_removed.py").write_text("stale")
    write_kit([("scripts/discover.py", b"new")], dest, force=True)
    assert (dest / "scripts" / "discover.py").read_text() == "new"
    assert not (dest / "scripts" / "old_removed.py").exists()  # stale file purged


def test_bad_input_preserves_existing_install(tmp_path: Path) -> None:
    # validation runs before any deletion -> a bad path must not destroy the prior --force install.
    dest = tmp_path / "skill"
    (dest / "scripts").mkdir(parents=True)
    (dest / "scripts" / "keep.py").write_text("existing")
    with pytest.raises(InstallError):
        write_kit([("SKILL.md", b"new"), ("scripts/../evil", b"x")], dest, force=True)
    assert (dest / "scripts" / "keep.py").read_text() == "existing"  # untouched
    assert not (dest / "SKILL.md").exists()  # nothing written


# --- fetch_kit_files: thin contents-API recursion against a real server ---------------------------

class _ContentsHandler(BaseHTTPRequestHandler):
    """minimal stand-in for the GitHub contents API + raw file host."""

    def log_message(self, *args: object) -> None:  # silence test server logging
        pass

    def _json(self, payload: object) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def _raw(self, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        base = f"http://{self.headers['Host']}"
        path = self.path.split("?", 1)[0]
        match path:
            case "/contents/migration-kit":
                self._json([
                    {"name": "SKILL.md", "path": "migration-kit/SKILL.md", "type": "file",
                     "download_url": f"{base}/raw/SKILL.md"},
                    {"name": "scripts", "path": "migration-kit/scripts", "type": "dir"},
                    {"name": "references", "path": "migration-kit/references", "type": "dir"},
                    # these must be skipped, not fetched:
                    {"name": "tests", "path": "migration-kit/tests", "type": "dir"},
                    {"name": "pyproject.toml", "path": "migration-kit/pyproject.toml", "type": "file",
                     "download_url": f"{base}/raw/pyproject.toml"},
                ])
            case "/contents/migration-kit/scripts":
                self._json([{"name": "discover.py", "path": "migration-kit/scripts/discover.py",
                             "type": "file", "download_url": f"{base}/raw/discover.py"}])
            case "/contents/migration-kit/references":
                self._json([{"name": "install.md", "path": "migration-kit/references/install.md",
                             "type": "file", "download_url": f"{base}/raw/install.md"}])
            case "/raw/SKILL.md":
                self._raw(b"skill-body")
            case "/raw/discover.py":
                self._raw(b"discover-body")
            case "/raw/install.md":
                self._raw(b"install-body")
            case _:
                self.send_response(404)
                self.end_headers()


@pytest.fixture()
def server() -> Iterator[str]:
    httpd = HTTPServer(("127.0.0.1", 0), _ContentsHandler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}"
    finally:
        httpd.shutdown()
        thread.join()


def test_fetch_pulls_only_the_runtime_allowlist(server: str) -> None:
    files = fetch_kit_files("main", api=server + "/contents/{path}", allowed_hosts=(server + "/",))
    assert dict(files) == {
        "SKILL.md": b"skill-body",
        "scripts/discover.py": b"discover-body",
        "references/install.md": b"install-body",
    }  # tests/ and pyproject.toml were skipped, never fetched


def test_fetch_rejects_response_from_unexpected_host(server: str) -> None:
    # the server is real, but we pin a different allowed host -> the listing must be refused.
    with pytest.raises(InstallError, match="unexpected host"):
        fetch_kit_files("main", api=server + "/contents/{path}", allowed_hosts=("https://example.invalid/",))
