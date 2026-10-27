"""Exercise the shipped Quickstart assertions against real loopback HTTP."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORKFLOW = Path(__file__).parents[1] / "workflows/platform-e2e-tests.yml"


class HealthHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        body = b'{"status":"ok"}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class QuickstartLoopbackTests(unittest.TestCase):
    def setUp(self):
        workflow = WORKFLOW.read_text()
        marker = ("      - name: Assert the container never dials a dead loopback address\n"
                  "        run: |\n")
        self.assertIn(marker, workflow)
        script = workflow.split(marker, 1)[1].split("\n      - name:", 1)[0]
        self.assertions = re.findall(r"node([^'\n]*) -e '([^']*)'\s*\|\| rc=1", script)
        self.assertEqual(len(self.assertions), 3, "Exercise every hard loopback assertion")
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def check_manifest(self, rewrites):
        with tempfile.TemporaryDirectory() as directory:
            manifest = Path(directory) / "routes-manifest.json"
            manifest.write_text(json.dumps({"rewrites": rewrites}))
            env = os.environ | {"LOOPBACK_TEST_MANIFEST": str(manifest),
                                "ARCHESTRA_INTERNAL_API_BASE_URL": self.origin,
                                "NODE_OPTIONS": "--max-old-space-size=4096"}
            results = []
            for flags, program in self.assertions:
                # Only the container filesystem boundary is replaced. The exact
                # assertions, Node flags, URL parsing and HTTP requests run.
                program = program.replace('require("/app/frontend/.next/routes-manifest.json")',
                                          'require(process.env.LOOPBACK_TEST_MANIFEST)')
                results.append(subprocess.run(["node", *shlex.split(flags), "-e", program],
                                              env=env, text=True, capture_output=True, timeout=10))
            return results

    def assert_passes(self, rewrites):
        for result in self.check_manifest(rewrites):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_phased_manifest_reaches_the_backend(self):
        for phase in ("beforeFiles", "afterFiles", "fallback"):
            with self.subTest(phase=phase):
                self.assert_passes({phase: [{"destination": self.origin + "/v1/:path*"},
                                           {"destination": "/api/auth/oauth2/authorize"},
                                           {"destination": "https://:host.ingest.example/api/:path*"}]})

    def test_localhost_is_rejected(self):
        route = {"destination": f"http://localhost:{self.server.server_port}/api/:path*"}
        result = self.check_manifest({"afterFiles": [route]})[1]
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("these resolve to ::1 first", result.stderr)

    def test_missing_loopback_routes_still_fail(self):
        for rewrites in ([], {"beforeFiles": []}):
            with self.subTest(rewrites=rewrites):
                result = self.check_manifest(rewrites)[2]
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("no loopback proxy destination", result.stderr)

    def test_unreachable_backend_still_fails(self):
        result = self.check_manifest({"afterFiles": [{"destination": "http://127.0.0.1:1/api/:path*"}]})[2]
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unreachable on its first-resolved address", result.stderr)

    def test_non_http_destinations_are_not_dialled(self):
        result = self.check_manifest({"afterFiles": [{"destination": "ftp://127.0.0.1:9000/api/:path*"}]})[2]
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no loopback proxy destination", result.stderr)
