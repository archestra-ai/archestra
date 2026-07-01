"""tests for the urllib-based client against a REAL local http.server (no mocks).

these exercise the stdlib pieces that replaced httpx: cookie-jar persistence across requests,
error-body preservation, the no-silent-redirect policy, and content-type decoding.
"""
import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from archestra_client import ArchestraApiError, ArchestraClient, HookCreate, _items
from contracts import ContractError


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # silence test server logging
        pass

    def _send(self, code: int, body: str | None, ctype: str = "application/json",
              extra: list[tuple[str, str]] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for key, value in extra or []:
            self.send_header(key, value)
        self.end_headers()
        if body is not None:
            self.wfile.write(body.encode())

    def do_POST(self) -> None:
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        match self.path:
            case "/api/auth/sign-in/email":
                self._send(200, json.dumps({"ok": True}), extra=[("Set-Cookie", "sess=abc; Path=/")])
            case "/api/api-keys":
                if "sess=abc" in self.headers.get("Cookie", ""):
                    self._send(200, json.dumps({"key": "sk-minted"}))
                else:
                    self._send(401, json.dumps({"error": "missing session cookie"}))
            case "/api/redirect":
                self._send(302, None, extra=[("Location", "http://example.invalid/elsewhere")])
            case "/api/boom":
                self._send(500, json.dumps({"error": "kaboom detail"}))
            case _:
                self._send(404, json.dumps({"error": "not found"}))

    def do_GET(self) -> None:
        match self.path:
            case "/ready":
                self._send(200, json.dumps({"status": "ok", "database": "connected"}))
            case "/text":
                self._send(200, "plain words", ctype="text/plain")
            case "/api/badjson":
                self._send(200, "{not valid json", ctype="application/json")
            case _:
                self._send(404, json.dumps({"error": "not found"}))


@pytest.fixture()
def base_url() -> Iterator[str]:
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        thread.join()


def test_wait_ready(base_url: str) -> None:
    with ArchestraClient(base_url) as client:
        assert client.wait_ready(timeout_s=5, interval_s=0.1)["database"] == "connected"


def test_session_cookie_carries_from_sign_in_to_mint(base_url: str) -> None:
    with ArchestraClient(base_url) as client:
        client.sign_in("a@b.c", "pw")  # sets the session cookie
        # mint_api_key 401s unless the cookie jar carried the cookie from sign_in.
        assert client.mint_api_key("migration") == "sk-minted"


def test_error_body_is_preserved(base_url: str) -> None:
    with ArchestraClient(base_url) as client:
        with pytest.raises(ArchestraApiError) as excinfo:
            client._request("POST", "/api/boom")
        assert excinfo.value.status == 500
        assert "kaboom detail" in excinfo.value.body


def test_redirect_is_not_followed(base_url: str) -> None:
    with ArchestraClient(base_url) as client:
        with pytest.raises(ArchestraApiError) as excinfo:
            client._request("POST", "/api/redirect")
        assert excinfo.value.status == 302  # surfaced, not followed


def test_text_and_json_decoding(base_url: str) -> None:
    with ArchestraClient(base_url) as client:
        assert client._request("GET", "/text") == "plain words"
        assert client._request("GET", "/ready") == {"status": "ok", "database": "connected"}


def test_items_raises_on_unexpected_shape() -> None:
    # a silent [] would make idempotency checks miss existing entities -> duplicate creates.
    # ContractError (a ValueError) is what apply.py's except clause handles -> recorded as failed.
    with pytest.raises(ContractError, match="unexpected list-response"):
        _items({"unexpected": "envelope"})
    with pytest.raises(ContractError, match="not an object"):
        _items([{"ok": 1}, "not-an-object"])


def test_malformed_json_body_becomes_api_error(base_url: str) -> None:
    # a non-JSON body under an application/json content-type must not crash the migration loop.
    with ArchestraClient(base_url) as client:
        with pytest.raises(ArchestraApiError) as excinfo:
            client._request("GET", "/api/badjson")
        assert excinfo.value.status == 0  # no HTTP status -> apply.py records a failed op


def test_transport_error_becomes_api_error() -> None:
    # a closed port -> URLError (an OSError) -> ArchestraApiError(status 0), not an uncaught crash.
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    with ArchestraClient(f"http://127.0.0.1:{port}", timeout=2.0) as client:
        with pytest.raises(ArchestraApiError) as excinfo:
            client._request("GET", "/ready")
        assert excinfo.value.status == 0


def test_sign_in_refuses_insecure_transport() -> None:
    with ArchestraClient("http://api.example.com") as client:
        with pytest.raises(ValueError, match="insecure transport"):
            client.sign_in("a@b.c", "pw")


def test_sign_in_allows_localhost_http(base_url: str) -> None:
    # local docker over loopback http is fine -- no network exposure of the credentials.
    with ArchestraClient(base_url) as client:
        client.sign_in("a@b.c", "pw")


class _NotReadyHandler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(404)  # wrong base URL / misconfig -> a permanent client error
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error": "no such route"}')


class _HooksHandler(BaseHTTPRequestHandler):
    received: list[tuple[str, str, dict[str, object] | None]] = []

    def log_message(self, *args: object) -> None:
        pass

    def _send(self, code: int, body: dict[str, object] | list[object]) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self) -> None:
        self.received.append(("GET", self.path, None))
        self._send(200, {"items": [{"id": "h1", "event": "pre_tool_use", "fileName": "g.py"}]})

    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.received.append(("POST", self.path, json.loads(raw)))
        self._send(200, {"id": "new-hook"})


def test_hook_list_and_create_serialize_correctly() -> None:
    _HooksHandler.received = []
    server = HTTPServer(("127.0.0.1", 0), _HooksHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with ArchestraClient(f"http://127.0.0.1:{server.server_address[1]}") as client:
            listed = client.list_hooks("agent-123")
            assert listed[0]["id"] == "h1"  # the {items: [...]} envelope is unwrapped
            created = client.create_hook(HookCreate(
                agentId="agent-123", event="pre_tool_use", fileName="g.py",
                content="x", requirements=["httpx"], enabled=True))
            assert created["id"] == "new-hook"
    finally:
        server.shutdown()
        thread.join()

    get_method, get_path, _ = _HooksHandler.received[0]
    assert get_method == "GET"
    assert get_path == "/api/hooks?agentId=agent-123"
    post_method, post_path, body = _HooksHandler.received[1]
    assert (post_method, post_path) == ("POST", "/api/hooks")
    assert body == {"agentId": "agent-123", "event": "pre_tool_use", "fileName": "g.py",
                    "content": "x", "requirements": ["httpx"], "enabled": True}


def test_wait_ready_fails_fast_on_client_error() -> None:
    server = HTTPServer(("127.0.0.1", 0), _NotReadyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with ArchestraClient(f"http://127.0.0.1:{server.server_address[1]}") as client:
            # a 4xx must raise immediately, not spin until timeout_s.
            with pytest.raises(ArchestraApiError) as excinfo:
                client.wait_ready(timeout_s=10, interval_s=0.1)
            assert excinfo.value.status == 404
    finally:
        server.shutdown()
        thread.join()
