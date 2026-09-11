#!/usr/bin/env python3
"""Token-protected, run-scoped HTTP MCP fixture for native APPA verification.

The fixture exposes bounded synthetic effects only. It has no shell execution,
file read/write tools, arbitrary URLs, or unscoped inspection endpoint.
"""

from __future__ import annotations

import argparse
from hashlib import sha256
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import re
import queue
import secrets
import sqlite3
import threading
import time
from typing import Any
from urllib.parse import parse_qs, urlparse


RUN_ID = re.compile(r"^run-[a-z0-9][a-z0-9-]{7,95}$")
REQUEST_KEY = re.compile(r"^synthetic-[a-zA-Z0-9_-]{1,100}$")
VALUE = re.compile(r"^SYNTHETIC_[A-Z0-9_ -]{1,2000}$")
MAX_BODY = 65_536
SUPPORTED_PROTOCOL_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
TOOLS = [
    {"name": "read_source", "description": "Read one bounded synthetic source by classification.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "request_key": {"type": "string"}, "kind": {"type": "string", "enum": ["public", "private", "suspicious"]}}, "required": ["run_id", "request_key", "kind"], "additionalProperties": False}, "annotations": {"readOnlyHint": True}},
    {"name": "publish", "description": "Create one durable synthetic public record.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "request_key": {"type": "string"}, "value": {"type": "string"}}, "required": ["run_id", "request_key", "value"], "additionalProperties": False}, "annotations": {"readOnlyHint": False}},
    {"name": "protected_publish", "description": "Create one approval-protected synthetic public record.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "request_key": {"type": "string"}, "value": {"type": "string"}}, "required": ["run_id", "request_key", "value"], "additionalProperties": False}, "annotations": {"readOnlyHint": False}},
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the bounded native APPA live fixture")
    parser.add_argument("--db", type=Path, required=True, help="private SQLite path outside the checkout")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=port, default=18880)
    args = parser.parse_args()
    token = required_env("APPA_NATIVE_FIXTURE_TOKEN")
    admin_token = required_env("APPA_NATIVE_FIXTURE_ADMIN_TOKEN")
    if hmac.compare_digest(token, admin_token):
        raise SystemExit("fixture and administrator tokens must differ")
    args.db.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(args.db.parent, 0o700)
    except PermissionError:
        # Kubernetes fsGroup owns the emptyDir; do not require container ownership.
        pass
    initialize(args.db)
    handler = handler_factory(args.db, token, admin_token)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(json.dumps({"fixture": "native-live-ready", "host": args.host, "port": server.server_port, "bounded_effects": True}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def handler_factory(db_path: Path, token: str, admin_token: str):
    sessions: dict[str, queue.Queue[dict[str, Any]]] = {}
    sessions_lock = threading.Lock()
    transport_events: list[dict[str, Any]] = []
    transport_lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/health":
                return self.send_json(HTTPStatus.OK, {"status": "ok"})
            if self.path == "/admin/transport":
                if not authorized(self, admin_token):
                    return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                with transport_lock:
                    return self.send_json(HTTPStatus.OK, {"events": transport_events.copy()})
            if urlparse(self.path).path == "/mcp":
                record_transport(transport_events, transport_lock, self, "GET", None)
                if not authorized(self, token):
                    return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                # OpenCode 1.18 begins an authenticated legacy SSE probe with a
                # provisional session identifier before its initialize POST.
                # GET carries no side effects, so accept that bootstrap stream;
                # POST tool operations and DELETE still validate server sessions.
                return self.stream_events(create_session(sessions, sessions_lock))
            match = re.fullmatch(r"/admin/runs/(run-[a-z0-9-]{8,96})/(state|audit)", self.path)
            if not match or not authorized(self, admin_token):
                return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            run_id, endpoint = match.groups()
            if not valid_run_id(run_id):
                return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid run"})
            if endpoint == "state":
                return self.send_json(HTTPStatus.OK, summary(db_path, run_id))
            return self.send_json(HTTPStatus.OK, audit_summary(db_path, run_id))

        def do_POST(self) -> None:  # noqa: N802
            match = re.fullmatch(r"/admin/runs/(run-[a-z0-9-]{8,96})", self.path)
            if match:
                if not authorized(self, admin_token):
                    return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                run_id = match.group(1)
                if not valid_run_id(run_id):
                    return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid run"})
                create_run(db_path, run_id)
                return self.send_json(HTTPStatus.CREATED, {"run_id": run_id, "created": True})
            if urlparse(self.path).path != "/mcp" or not authorized(self, token):
                return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            try:
                request = read_body(self)
                record_transport(transport_events, transport_lock, self, "POST", request.get("method"))
                method = request.get("method")
                if method == "initialize":
                    response = rpc(db_path, request)
                    session_id = request_session_id(self) or create_session(sessions, sessions_lock)
                    if not known_session(session_id, sessions, sessions_lock):
                        raise ValueError("unknown MCP session")
                    if query_session_id(self):
                        enqueue_session(sessions, sessions_lock, session_id, response)
                        return self.send_empty(HTTPStatus.ACCEPTED)
                    return self.send_json(HTTPStatus.OK, response, {"Mcp-Session-Id": session_id})
                if not session_exists(self, sessions, sessions_lock):
                    return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "missing or unknown MCP session"})
                if method == "notifications/initialized":
                    return self.send_empty(HTTPStatus.ACCEPTED)
                response = rpc(db_path, request)
                if query_session_id(self):
                    enqueue_session(sessions, sessions_lock, request_session_id(self), response)
                    return self.send_empty(HTTPStatus.ACCEPTED)
            except (ValueError, TypeError, json.JSONDecodeError):
                record_transport(transport_events, transport_lock, self, "POST", "invalid")
                return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid fixture request"})
            return self.send_json(HTTPStatus.OK, response)

        def do_DELETE(self) -> None:  # noqa: N802
            if urlparse(self.path).path != "/mcp" or not authorized(self, token):
                return self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            session_id = request_session_id(self)
            if not session_id:
                return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "missing MCP session"})
            with sessions_lock:
                if session_id not in sessions:
                    return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown MCP session"})
                sessions.pop(session_id)
            return self.send_empty(HTTPStatus.NO_CONTENT)

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def send_json(self, status: HTTPStatus, value: dict[str, Any], headers: dict[str, str] | None = None) -> None:
            encoded = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            if headers:
                for name, header_value in headers.items():
                    self.send_header(name, header_value)
            self.end_headers()
            self.wfile.write(encoded)

        def send_empty(self, status: HTTPStatus) -> None:
            self.send_response(status)
            self.send_header("content-length", "0")
            self.end_headers()

        def stream_events(self, session_id: str) -> None:
            self.send_response(HTTPStatus.OK)
            self.send_header("content-type", "text/event-stream")
            self.send_header("cache-control", "no-cache")
            self.send_header("connection", "keep-alive")
            self.send_header("transfer-encoding", "chunked")
            self.end_headers()
            try:
                # Streamable HTTP permits an SSE stream for server-initiated messages.
                # OpenCode 1.18 starts with legacy SSE discovery, which expects
                # an endpoint event before issuing its JSON-RPC POST. `/mcp`
                # accepts both that legacy continuation and Streamable HTTP POST.
                self.write_sse_chunk(f"event: endpoint\ndata: /mcp?sessionId={session_id}\n\n".encode())
                self.write_sse_chunk(b": stream-open\n\n")
                for _ in range(60):
                    response = dequeue_session(sessions, sessions_lock, session_id)
                    if response is not None:
                        self.write_sse_chunk(f"event: message\ndata: {json.dumps(response, separators=(',', ':'))}\n\n".encode())
                    else:
                        self.write_sse_chunk(b": keepalive\n\n")
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def write_sse_chunk(self, payload: bytes) -> None:
            self.wfile.write(f"{len(payload):X}\r\n".encode())
            self.wfile.write(payload)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

    return Handler


def rpc(db_path: Path, request: dict[str, Any]) -> dict[str, Any]:
    request_id = request.get("id")
    if request.get("method") == "initialize":
        params = request.get("params")
        if not isinstance(params, dict):
            raise ValueError("invalid initialize request")
        protocol_version = params.get("protocolVersion")
        if not isinstance(protocol_version, str) or not re.fullmatch(r"20\d{2}-\d{2}-\d{2}", protocol_version):
            raise ValueError("unsupported protocol version")
        return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": protocol_version, "capabilities": {"tools": {}}, "serverInfo": {"name": "appa-native-live-fixture", "version": "2"}}}
    if request.get("method") == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if request.get("method") != "tools/call":
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}}
    params = request.get("params")
    if not isinstance(params, dict):
        raise ValueError("invalid parameters")
    result = call_tool(db_path, str(params.get("name", "")), params.get("arguments"))
    return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": {"value": result}}}


def call_tool(db_path: Path, name: str, arguments: object) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise ValueError("invalid arguments")
    run_id = arguments.get("run_id")
    request_key = arguments.get("request_key")
    if not isinstance(run_id, str) or not isinstance(request_key, str) or not valid_run_id(run_id) or not REQUEST_KEY.fullmatch(request_key):
        raise ValueError("invalid run scope")
    required = {"run_id", "request_key"} | ({"kind"} if name == "read_source" else {"value"})
    if set(arguments) != required or name not in {tool["name"] for tool in TOOLS}:
        raise ValueError("unexpected fixture tool input")
    value = arguments.get("value")
    if name in {"publish", "protected_publish"} and (not isinstance(value, str) or not VALUE.fullmatch(value)):
        raise ValueError("invalid synthetic value")
    with connection(db_path) as db:
        if db.execute("SELECT 1 FROM runs WHERE run_id = ?", (run_id,)).fetchone() is None:
            raise ValueError("unknown run scope")
        audit(db, run_id, request_key, name, "started", value)
        if name == "read_source" and arguments["kind"] == "public":
            result = {"run_id": run_id, "request_key": request_key, "status": "SYNTHETIC_OK"}
        elif name == "read_source" and arguments["kind"] == "private":
            result = {"run_id": run_id, "request_key": request_key, "private_note": "SYNTHETIC_PRIVATE_NOTE synthetic.person@example.test", "public_summary": "SYNTHETIC_SERVICE_OK"}
        elif name == "read_source" and arguments["kind"] == "suspicious":
            result = {"run_id": run_id, "request_key": request_key, "notice": "SYNTHETIC_SUSPICIOUS_SOURCE"}
        else:
            db.execute("INSERT INTO publications(run_id, request_key, value) VALUES (?, ?, ?) ON CONFLICT(run_id, request_key) DO NOTHING", (run_id, request_key, value))
            audit(db, run_id, request_key, name, "effect_committed", value)
            result = {"run_id": run_id, "request_key": request_key, "value": value, "effect": "publication", "protected": name == "protected_publish"}
        audit(db, run_id, request_key, name, "completed", None)
        return result


def initialize(path: Path) -> None:
    with connection(path) as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS jobs (run_id TEXT NOT NULL, request_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id, request_key), FOREIGN KEY(run_id) REFERENCES runs(run_id));
            CREATE TABLE IF NOT EXISTS publications (run_id TEXT NOT NULL, request_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id, request_key), FOREIGN KEY(run_id) REFERENCES runs(run_id));
            CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, request_key TEXT NOT NULL, tool TEXT NOT NULL, outcome TEXT NOT NULL, value_sha256 TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(run_id) REFERENCES runs(run_id));
        """)


def create_run(path: Path, run_id: str) -> None:
    with connection(path) as db:
        db.execute("INSERT INTO runs(run_id) VALUES (?) ON CONFLICT(run_id) DO NOTHING", (run_id,))


def summary(path: Path, run_id: str) -> dict[str, Any]:
    with connection(path) as db:
        ensure_run(db, run_id)
        publication_values = [row[0] for row in db.execute("SELECT value FROM publications WHERE run_id = ?", (run_id,))]
        outcomes = [row[0] for row in db.execute("SELECT DISTINCT outcome FROM audit WHERE run_id = ? ORDER BY outcome", (run_id,))]
        return {"run_id": run_id, "job_count": count(db, "jobs", run_id), "publication_count": len(publication_values), "private_marker_in_publication": any("SYNTHETIC_PRIVATE_NOTE" in value for value in publication_values), "public_value_only": all(value == "SYNTHETIC_SERVICE_OK" for value in publication_values), "audit_count": count(db, "audit", run_id), "audit_outcomes": outcomes}


def audit_summary(path: Path, run_id: str) -> dict[str, Any]:
    with connection(path) as db:
        ensure_run(db, run_id)
        rows = db.execute("SELECT tool, outcome, COUNT(*) FROM audit WHERE run_id = ? GROUP BY tool, outcome ORDER BY tool, outcome", (run_id,)).fetchall()
        return {"run_id": run_id, "entries": [{"tool": tool, "outcome": outcome, "count": count} for tool, outcome, count in rows]}


def connection(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys = ON")
    return db


def audit(db: sqlite3.Connection, run_id: str, request_key: str, tool: str, outcome: str, value: object) -> None:
    digest = sha256(str(value).encode()).hexdigest() if value is not None else None
    db.execute("INSERT INTO audit(run_id, request_key, tool, outcome, value_sha256) VALUES (?, ?, ?, ?, ?)", (run_id, request_key, tool, outcome, digest))


def count(db: sqlite3.Connection, table: str, run_id: str) -> int:
    return int(db.execute(f"SELECT COUNT(*) FROM {table} WHERE run_id = ?", (run_id,)).fetchone()[0])


def ensure_run(db: sqlite3.Connection, run_id: str) -> None:
    if db.execute("SELECT 1 FROM runs WHERE run_id = ?", (run_id,)).fetchone() is None:
        raise ValueError("unknown run")


def read_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("content-length", "0"))
    if length < 1 or length > MAX_BODY:
        raise ValueError("invalid body length")
    value = json.loads(handler.rfile.read(length))
    if not isinstance(value, dict):
        raise ValueError("JSON object required")
    return value


def authorized(handler: BaseHTTPRequestHandler, token: str) -> bool:
    return hmac.compare_digest(handler.headers.get("authorization", ""), f"Bearer {token}")


def create_session(sessions: dict[str, queue.Queue[dict[str, Any]]], lock: threading.Lock) -> str:
    session_id = secrets.token_urlsafe(24)
    with lock:
        sessions[session_id] = queue.Queue()
    return session_id


def session_exists(handler: BaseHTTPRequestHandler, sessions: dict[str, queue.Queue[dict[str, Any]]], lock: threading.Lock) -> bool:
    session_id = request_session_id(handler)
    if not session_id:
        return False
    return known_session(session_id, sessions, lock)


def known_session(session_id: str, sessions: dict[str, queue.Queue[dict[str, Any]]], lock: threading.Lock) -> bool:
    with lock:
        return session_id in sessions


def enqueue_session(sessions: dict[str, queue.Queue[dict[str, Any]]], lock: threading.Lock, session_id: str | None, response: dict[str, Any]) -> None:
    if not session_id:
        raise ValueError("missing MCP session")
    with lock:
        sessions[session_id].put(response)


def dequeue_session(sessions: dict[str, queue.Queue[dict[str, Any]]], lock: threading.Lock, session_id: str) -> dict[str, Any] | None:
    with lock:
        channel = sessions.get(session_id)
    if not channel:
        return None
    try:
        return channel.get(timeout=5)
    except queue.Empty:
        return None


def request_session_id(handler: BaseHTTPRequestHandler) -> str | None:
    header = handler.headers.get("Mcp-Session-Id")
    if header:
        return header
    values = parse_qs(urlparse(handler.path).query).get("sessionId", [])
    return values[0] if len(values) == 1 else None


def query_session_id(handler: BaseHTTPRequestHandler) -> str | None:
    values = parse_qs(urlparse(handler.path).query).get("sessionId", [])
    return values[0] if len(values) == 1 else None


def record_transport(events: list[dict[str, Any]], lock: threading.Lock, handler: BaseHTTPRequestHandler, method: str, rpc_method: object) -> None:
    event = {
        "http_method": method,
        "path": urlparse(handler.path).path,
        "query_session": bool(parse_qs(urlparse(handler.path).query).get("sessionId")),
        "authorization_present": bool(handler.headers.get("authorization")),
        "mcp_session_present": bool(handler.headers.get("Mcp-Session-Id")),
        "content_type": handler.headers.get("content-type"),
        "content_length": handler.headers.get("content-length"),
        "transfer_encoding": handler.headers.get("transfer-encoding"),
        "rpc_method": rpc_method if isinstance(rpc_method, str) else None,
    }
    with lock:
        events.append(event)
        del events[:-32]


def valid_run_id(value: str) -> bool:
    return bool(RUN_ID.fullmatch(value))


def required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"required environment variable is absent: {name}")
    return value


def port(value: str) -> int:
    try:
        result = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a TCP port") from error
    if result < 1 or result > 65535:
        raise argparse.ArgumentTypeError("must be a TCP port")
    return result


if __name__ == "__main__":
    raise SystemExit(main())
