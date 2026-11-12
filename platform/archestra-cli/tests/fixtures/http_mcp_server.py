#!/usr/bin/env python3
"""Test MCP server over streamable HTTP: the tools of files_mcp_server.py.

Usage: http_mcp_server.py <root> <port>

It listens on 127.0.0.1:<port>. Python standard library only.
- POST /mcp answers with a JSON body.
- POST /sse answers with an SSE stream (a notification, then the response).

`initialize` gives an `Mcp-Session-Id`. Each later request must have it: a
request with no session or an unknown session gets `404`.
"""

import json
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# No __pycache__ folder next to the fixtures.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from files_mcp_server import Server  # noqa: E402

SESSION_HEADER = "Mcp-Session-Id"


def make_handler(root):
    sessions = {}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):  # noqa: A002
            pass

        def send_body(self, status, content_type, body, session_id=None):
            self.send_response(status)
            if content_type:
                self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if session_id:
                self.send_header(SESSION_HEADER, session_id)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802
            if self.path not in ("/mcp", "/sse"):
                self.send_body(404, "text/plain", b"not found")
                return
            length = int(self.headers.get("Content-Length", "0"))
            message = json.loads(self.rfile.read(length))

            session_id = self.headers.get(SESSION_HEADER)
            if message.get("method") == "initialize":
                session_id = uuid.uuid4().hex
                with lock:
                    sessions[session_id] = Server(root, "files-http")
            with lock:
                server = sessions.get(session_id)
            if server is None:
                self.send_body(404, "text/plain", b"unknown session")
                return

            response = server.handle(message)
            if response is None:
                self.send_body(202, None, b"", session_id)
            elif self.path == "/sse":
                notification = {"jsonrpc": "2.0", "method": "notifications/message", "params": {}}
                body = "".join(
                    f"event: message\ndata: {json.dumps(event)}\n\n"
                    for event in (notification, response)
                )
                self.send_body(200, "text/event-stream", body.encode(), session_id)
            else:
                self.send_body(200, "application/json", json.dumps(response).encode(), session_id)

    return Handler


def main(argv):
    if len(argv) != 3:
        sys.exit("usage: http_mcp_server.py <root> <port>")
    server = ThreadingHTTPServer(("127.0.0.1", int(argv[2])), make_handler(argv[1]))
    server.serve_forever()


if __name__ == "__main__":
    main(sys.argv)
