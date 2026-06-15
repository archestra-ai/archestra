"""Raw artifact download + artifact resolution, against a real stdlib HTTP stub (no SUT mocks).

Covers the binary-safety fix (download_file_bytes must not coerce bytes to text) and the harness's
generated-artifact matching (match / missing / ambiguous).
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from archestra_client import ArchestraApiError
from eval_client import EvalClient
from run import _resolve_artifact, _RunArtifacts
from tasks import Task, Verifier

_BINARY = bytes(range(256))


def _generated(name: str) -> dict:
    return {"id": "aaa", "name": name, "mimeType": "application/zip", "contentUrl": "/api/skill-sandbox/artifacts/aaa"}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # silence
        pass

    def _json(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib handler API)
        if self.path == "/api/skill-sandbox/artifacts/aaa":
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(_BINARY)))
            self.end_headers()
            self.wfile.write(_BINARY)
        elif self.path == "/api/chat/conversations/ok/files":
            self._json({"generated": [_generated("pi.zip")], "attachments": []})
        elif self.path == "/api/chat/conversations/missing/files":
            self._json({"generated": [_generated("other.zip")], "attachments": []})
        elif self.path == "/api/chat/conversations/dup/files":
            self._json({"generated": [_generated("pi.zip"), _generated("pi.zip")], "attachments": []})
        elif self.path == "/api/chat/conversations/boom/files":
            self.send_error(500)
        else:
            self.send_error(404)


@pytest.fixture
def client() -> Iterator[EvalClient]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield EvalClient(f"http://127.0.0.1:{server.server_address[1]}")
    finally:
        server.shutdown()


def _task() -> Task:
    return Task(id="t", dir=Path("."), stages=(), result_schema={}, verifier=Verifier(), artifact_key="artifact")


def test_download_file_bytes_is_byte_exact(client: EvalClient) -> None:
    assert client.download_file_bytes("/api/skill-sandbox/artifacts/aaa") == _BINARY


def test_resolve_artifact_downloads_match(client: EvalClient, tmp_path: Path) -> None:
    artifacts = _RunArtifacts(tmp_path / "art")
    paths: dict = {}
    data = _resolve_artifact(client, "ok", _task(), b'{"artifact": "pi.zip"}', artifacts, paths)
    assert data == _BINARY
    assert Path(paths["artifact"]).read_bytes() == _BINARY


def test_resolve_artifact_missing_returns_none(client: EvalClient, tmp_path: Path) -> None:
    artifacts = _RunArtifacts(tmp_path / "art")
    assert _resolve_artifact(client, "missing", _task(), b'{"artifact": "pi.zip"}', artifacts, {}) is None


def test_resolve_artifact_ambiguous_returns_none(client: EvalClient, tmp_path: Path) -> None:
    artifacts = _RunArtifacts(tmp_path / "art")
    assert _resolve_artifact(client, "dup", _task(), b'{"artifact": "pi.zip"}', artifacts, {}) is None


def test_resolve_artifact_backend_error_propagates(client: EvalClient, tmp_path: Path) -> None:
    """A backend HTTP error is infra, not the agent's fault: it must raise (caller records an
    agent_error), never silently resolve to None (which would look like a graded FAILED)."""
    artifacts = _RunArtifacts(tmp_path / "art")
    with pytest.raises(ArchestraApiError):
        _resolve_artifact(client, "boom", _task(), b'{"artifact": "pi.zip"}', artifacts, {})
