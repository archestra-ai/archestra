#!/usr/bin/env python3
"""A stand-in for the GCE metadata server, in the dev VM.

Google's client libraries look for credentials in Application Default
Credentials, and the last place they look is the metadata server a Google
Cloud VM has. The dev VM has no credentials of its own, so this answers in its
place with an access token the Mac put in TOKEN_FILE (`dev-vm-sync.py
vertex`): a one-hour token of the dev-vm-vertex service account, which can
call Vertex AI models and nothing else. A process finds it through
GCE_METADATA_HOST=127.0.0.1:8970 (platform/.env).

It answers only what the libraries ask: that a metadata server is there, the
project, the account, and its token. Listens on 127.0.0.1 only.
"""
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8970
TOKEN_FILE = os.path.expanduser("~/.archestra-gcp/token.json")
BASE = "/computeMetadata/v1/"
NO_TOKEN = "no current Vertex AI token: run `scripts/dev-vm-sync.py vertex` on the Mac\n"


def current_token():
    """The token the Mac last pushed, or None when there is none or it ran out."""
    try:
        with open(TOKEN_FILE) as source:
            token = json.load(source)
    except (OSError, ValueError):
        return None
    if token.get("expires_at", 0) - time.time() < 60:
        return None
    return token


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # The real server refuses requests without this header, so a page that
        # tricks a browser into a request gets nothing.
        if self.headers.get("Metadata-Flavor") != "Google":
            return self.reply(403, "Missing Metadata-Flavor: Google header\n")
        path = self.path.split("?", 1)[0]
        if not path.startswith(BASE):
            return self.reply(404, "Not found\n")
        path = path[len(BASE):].rstrip("/")
        token = current_token()
        if path == "instance":
            return self.reply(200, "")
        if path == "universe/universe-domain":
            return self.reply(200, "googleapis.com")
        if token is None:
            return self.reply(503, NO_TOKEN)
        if path == "project/project-id":
            return self.reply(200, token["project_id"])
        if path == "instance/service-accounts":
            return self.reply(200, "default/\n%s/\n" % token["email"])
        account, _, field = path.removeprefix("instance/service-accounts/").partition("/")
        if not path.startswith("instance/service-accounts/") or account not in ("default", token["email"]):
            return self.reply(404, "Not found\n")
        if field == "email":
            return self.reply(200, token["email"])
        if field == "scopes":
            return self.reply(200, "https://www.googleapis.com/auth/cloud-platform\n")
        if field == "token":
            body = {
                "access_token": token["access_token"],
                "expires_in": int(token["expires_at"] - time.time()),
                "token_type": "Bearer",
            }
            return self.reply(200, json.dumps(body), "application/json")
        return self.reply(404, "Not found\n")

    def reply(self, status, body, content_type="application/text"):
        data = body.encode()
        self.send_response(status)
        self.send_header("Metadata-Flavor", "Google")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Quiet: a log line per token request would only bury real errors.
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
