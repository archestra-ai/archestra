"""Exercise the Dagger updater against a local fake of every upstream it reads."""

import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github/scripts/update-dagger.py"
SPEC = importlib.util.spec_from_file_location("update_dagger", SCRIPT)
UPDATER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPDATER)
CURRENT = UPDATER.current_version(ROOT)
MAJOR, MINOR, PATCH = UPDATER.key(CURRENT)
NEXT = f"{MAJOR}.{MINOR}.{PATCH + 2}"
NOW = dt.datetime(2030, 1, 31, tzinfo=dt.timezone.utc)
NEW_COMMIT = "1" * 40
NEW_CLI = "2" * 64
NEW_RUNC = "v9.9.9"
NEW_RUNC_COMMIT = "4" * 40
MANIFEST = '[package]\nname = "dagger-sdk"\nversion = "{version}"\n\n[dependencies.reqwest]\nversion = "0.11.0"\n'


class FakeUpstream(BaseHTTPRequestHandler):
    routes = {}

    def do_GET(self):
        route = self.routes.get(self.path)
        if route is None:
            self.send_response(404)
            self.end_headers()
            return
        body, headers = route
        self.send_response(200)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def crate(version, files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for path, data in files.items():
            info = tarfile.TarInfo(f"dagger-sdk-{version}/{path}")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class UpdateDaggerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        vendor = f"{UPDATER.VENDOR_DIR}/dagger-sdk-{CURRENT}"
        for name in (*UPDATER.VERSION_FILES, UPDATER.CARGO_LOCK, "platform/scripts/check-dagger-version-sync.sh"):
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, self.root / name)
        shutil.copytree(ROOT / vendor, self.root / vendor)
        self.vendored = {str(p.relative_to(ROOT / vendor)): p.read_bytes()
                         for p in (ROOT / vendor).rglob("*") if p.is_file() and p.name != "Cargo.toml"}
        self.new_sources = self.vendored | {"src/core/version.rs": f'pub const DAGGER_ENGINE_VERSION: &str = "{NEXT}";\n'.encode()}
        self.serve()

    def serve(self, *, published=None, new_manifest=None, tamper_crate=False, releases=None):
        published = published or (NOW - dt.timedelta(days=8)).isoformat().replace("+00:00", "Z")
        old_files = self.vendored | {"Cargo.toml": MANIFEST.format(version=CURRENT).encode(),
                                     "examples/demo.rs": b"fn main() {}\n"}
        new_files = self.new_sources | {"Cargo.toml": (new_manifest or MANIFEST).format(version=NEXT).encode(),
                                        "examples/demo.rs": b"fn main() {}\n"}
        index = json.dumps({"manifests": [{"platform": {"os": "linux", "architecture": arch}}
                                          for arch in ("amd64", "arm64")]}).encode()
        self.new_digest = f"sha256:{hashlib.sha256(index).hexdigest()}"
        routes = {
            "/repos/dagger/dagger/releases?per_page=100": releases or [
                {"tag_name": f"v{MAJOR}.{MINOR}.{PATCH + 3}", "published_at": published, "prerelease": True},
                {"tag_name": f"v{MAJOR}.{MINOR}.{PATCH + 4}", "published_at": published, "draft": True},
                {"tag_name": f"sdk/rust/v{NEXT}", "published_at": published},
                {"tag_name": f"v{NEXT}", "published_at": published},
                {"tag_name": f"v{CURRENT}", "published_at": "2029-01-01T00:00:00Z"},
            ],
            f"/repos/dagger/dagger/git/ref/tags/v{NEXT}": {"object": {"type": "tag", "sha": "9" * 40}},
            f"/repos/dagger/dagger/git/tags/{'9' * 40}": {"object": {"type": "commit", "sha": NEW_COMMIT}},
            f"/dagger/dagger/{NEW_COMMIT}/go.mod": b"module github.com/dagger/dagger\n\ngo 1.26.1\n",
            f"/dagger/dagger/{NEW_COMMIT}/toolchains/engine-dev/consts/consts.go":
                f'package consts\n\nconst (\n\tRuncVersion  = "{NEW_RUNC}"\n)\n'.encode(),
            f"/repos/opencontainers/runc/git/ref/tags/{NEW_RUNC}": {"object": {"type": "commit", "sha": NEW_RUNC_COMMIT}},
            f"/dagger/dagger/releases/download/v{NEXT}/checksums.txt":
                f"{'3' * 64}  dagger_v{NEXT}_darwin_arm64.tar.gz\n{NEW_CLI}  dagger_v{NEXT}_linux_amd64.tar.gz\n".encode(),
            f"/v2/engine/manifests/v{NEXT}": (index, {"Docker-Content-Digest": self.new_digest}),
        }
        for version, files in ((CURRENT, old_files), (NEXT, new_files)):
            archive = crate(version, files)
            checksum = hashlib.sha256(b"tampered" if tamper_crate and version == NEXT else archive).hexdigest()
            routes[f"/api/v1/crates/dagger-sdk/{version}"] = {"version": {"checksum": checksum, "yanked": False}}
            routes[f"/api/v1/crates/dagger-sdk/{version}/download"] = archive
        FakeUpstream.routes = {path: value if isinstance(value, tuple) else
                               (value if isinstance(value, bytes) else json.dumps(value).encode(), {})
                               for path, value in routes.items()}

    def run_updater(self):
        env = os.environ | {f"DAGGER_UPDATER_{name}": self.base
                            for name in ("GITHUB_API", "GITHUB", "REGISTRY", "CRATES", "RAW")}
        env.pop("GH_TOKEN", None)
        return subprocess.run(["python3", str(SCRIPT), "--root", str(self.root), "--now", NOW.isoformat()],
                              env=env, text=True, capture_output=True)

    def snapshot(self):
        return {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob("*") if p.is_file()}

    def test_moves_every_pin_and_revendors_the_sdk_together(self):
        old_digest = UPDATER.Pins.read(ROOT, CURRENT).engine_digest
        result = self.run_updater()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"Updated Dagger {CURRENT} -> {NEXT}", result.stdout)
        self.assertEqual(UPDATER.current_version(self.root), NEXT)
        pins = UPDATER.Pins.read(self.root, NEXT)
        self.assertEqual((pins.commit, pins.engine_digest, pins.cli_checksum, pins.runc_version, pins.runc_commit),
                         (NEW_COMMIT, self.new_digest, NEW_CLI, NEW_RUNC, NEW_RUNC_COMMIT))
        # The patched engine starts from the new upstream engine, by digest.
        self.assertIn(f"ARG DAGGER_ENGINE_BASE_IMAGE=registry.dagger.io/engine:v{NEXT}@{self.new_digest}\n",
                      (self.root / UPDATER.DOCKERFILE).read_text())
        for name in UPDATER.VERSION_FILES:
            text = (self.root / name).read_text()
            self.assertNotIn(f"{CURRENT}", text.replace(f"{NEXT}", ""), name)
            self.assertNotIn(old_digest, text, name)
        self.assertIn(f'name = "dagger-sdk"\nversion = "{NEXT}"', (self.root / UPDATER.CARGO_LOCK).read_text())

        vendor = self.root / UPDATER.VENDOR_DIR
        self.assertEqual(sorted(p.name for p in vendor.iterdir()), [f"dagger-sdk-{NEXT}"])
        files = {str(p.relative_to(vendor / f"dagger-sdk-{NEXT}")): p.read_bytes()
                 for p in (vendor / f"dagger-sdk-{NEXT}").rglob("*") if p.is_file()}
        manifest = files.pop("Cargo.toml").decode()
        self.assertEqual(files, self.new_sources)
        self.assertNotIn(CURRENT, manifest.replace(NEXT, ""))
        checksum = FakeUpstream.routes[f"/api/v1/crates/dagger-sdk/{NEXT}"][0]
        self.assertIn(f"# Archive SHA-256: {json.loads(checksum)['version']['checksum']}", manifest)
        # The hand-normalized dependency backport carries forward unchanged.
        old_manifest = (ROOT / UPDATER.VENDOR_DIR / f"dagger-sdk-{CURRENT}/Cargo.toml").read_text()
        self.assertEqual(manifest.splitlines()[2:], [line.replace(CURRENT, NEXT) for line in old_manifest.splitlines()[2:]])

    def test_releases_inside_the_cooldown_or_not_newer_change_nothing(self):
        before = self.snapshot()
        self.serve(published=(NOW - dt.timedelta(days=2)).isoformat().replace("+00:00", "Z"))
        result = self.run_updater()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("already the newest release", result.stdout)
        self.serve(releases=[{"tag_name": f"v{MAJOR}.{MINOR}.{max(PATCH - 1, 0)}", "published_at": "2029-01-01T00:00:00Z"}])
        self.assertEqual(self.run_updater().returncode, 0)
        self.assertEqual(self.snapshot(), before)

    def test_unverifiable_or_incompatible_upstream_changes_fail_before_editing(self):
        before = self.snapshot()
        for case in ("manifest", "tamper", "local-patch"):
            with self.subTest(case=case):
                self.serve(new_manifest=MANIFEST.replace("0.11.0", "0.12.0") if case == "manifest" else None,
                           tamper_crate=case == "tamper")
                if case == "local-patch":
                    lib = self.root / UPDATER.VENDOR_DIR / f"dagger-sdk-{CURRENT}/src/lib.rs"
                    original = lib.read_bytes()
                    lib.write_bytes(original + b"// local patch\n")
                result = self.run_updater()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Dagger update failed", result.stderr)
                if case == "local-patch":
                    lib.write_bytes(original)
                self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
