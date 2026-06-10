"""tests for the urllib-based client against a REAL local http.server (no mocks).

these exercise the stdlib pieces that replaced httpx: cookie-jar persistence across requests,
error-body preservation, the no-silent-redirect policy, and content-type decoding.
"""
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from archestra_client import ArchestraApiError, ArchestraClient, _items


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
    with pytest.raises(ValueError, match="unexpected list-response"):
        _items({"unexpected": "envelope"})
    with pytest.raises(ValueError, match="not an object"):
        _items([{"ok": 1}, "not-an-object"])


class _NotReadyHandler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        self.send_response(404)  # wrong base URL / misconfig -> a permanent client error
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"error": "no such route"}')


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
