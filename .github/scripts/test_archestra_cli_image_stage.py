"""Run the archestra-cli-release stage of platform/Dockerfile outside Docker.

The stage's script uses paths relative to its working directory, so it runs
here in a directory of its own with the real `node` and `sha256sum`. `wget` is
the only fake: it serves files from a local directory.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = (ROOT / "platform/Dockerfile").read_text()
SPEC = importlib.util.spec_from_file_location(
    "archestra_cli_release_lock", Path(__file__).with_name("archestra-cli-release-lock.py"),
)
writer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(writer)

STAGE = DOCKERFILE.split(" AS archestra-cli-release\n", 1)[1].split("\nFROM ", 1)[0]
SCRIPT = STAGE.split("RUN <<'ARCHESTRA_CLI_RELEASE'\n", 1)[1].split("\nARCHESTRA_CLI_RELEASE\n", 1)[0]
URL = "https://github.com/archestra-ai/archestra/releases/download/archestra-cli-v0.2.0"


def content(name):
    return f"binary of {name}\n".encode()


class StageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.work = root / "work"
        self.served = root / "served"
        self.binaries = root / "bin"
        self.calls = root / "wget-calls"
        for directory in (self.work, self.served, self.binaries):
            directory.mkdir()
        for name in writer.FILES:
            (self.served / name).write_bytes(content(name))
        # `wget -q -T 60 -O FILE URL`: serve URL's last segment, and fail the
        # first ARCHESTRA_TEST_WGET_FAILURES calls.
        wget = self.binaries / "wget"
        wget.write_text(
            "#!/bin/bash\n"
            'printf "%s\\n" "$*" >> "$ARCHESTRA_TEST_WGET_CALLS"\n'
            'if [ "$(wc -l < "$ARCHESTRA_TEST_WGET_CALLS")" -le "$ARCHESTRA_TEST_WGET_FAILURES" ]; then exit 4; fi\n'
            'while [ "$#" -gt 2 ]; do\n'
            '  if [ "$1" = -O ]; then output="$2"; fi\n'
            "  shift\n"
            "done\n"
            'cp "$ARCHESTRA_TEST_SERVED/${2##*/}" "$output"\n'
        )
        wget.chmod(0o755)
        sleep = self.binaries / "sleep"
        sleep.write_text("#!/bin/bash\n")
        sleep.chmod(0o755)

    def lock(self, **changes):
        lock = writer.build("0.2.0", {
            name: hashlib.sha256(content(name)).hexdigest() for name in writer.FILES
        })
        return lock | changes

    def run_stage(self, lock, failures=0):
        # Each run starts as the stage does: the lock and nothing else.
        shutil.rmtree(self.work / "out", ignore_errors=True)
        self.calls.unlink(missing_ok=True)
        (self.work / "release.lock.json").write_text(lock if isinstance(lock, str) else writer.render(lock))
        result = subprocess.run(
            ["sh", "-c", SCRIPT], cwd=self.work, capture_output=True, text=True,
            env=os.environ | {
                "PATH": f"{self.binaries}:{os.environ['PATH']}",
                "ARCHESTRA_TEST_SERVED": str(self.served),
                "ARCHESTRA_TEST_WGET_CALLS": str(self.calls),
                "ARCHESTRA_TEST_WGET_FAILURES": str(failures),
            },
        )
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return result, calls

    def output(self):
        return sorted(entry.name for entry in (self.work / "out").iterdir())

    def test_empty_lock_builds_an_empty_directory_without_downloading(self):
        result, calls = self.run_stage(writer.EMPTY)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output(), [])
        self.assertEqual(calls, [])

    def test_committed_lock_builds(self):
        committed = writer.LOCK.read_text()
        if json.loads(committed) != writer.EMPTY:
            self.skipTest("The committed lock pins a release; only a real build downloads it.")
        result, _ = self.run_stage(committed)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output(), [])

    def test_pinned_release_is_downloaded_verified_and_described(self):
        result, calls = self.run_stage(self.lock())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output(), sorted([*writer.FILES, "manifest.json"]))
        for name in writer.FILES:
            with self.subTest(name=name):
                target = self.work / "out" / name
                self.assertEqual(target.read_bytes(), content(name))
                self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertEqual(json.loads((self.work / "out/manifest.json").read_text()), {"version": "0.2.0"})
        self.assertEqual(calls, [f"-q -T 60 -O {name} {URL}/{name}" for name in writer.FILES])

    def test_checksum_mismatch_fails(self):
        lock = self.lock()
        lock["files"]["archestra-windows-x86_64.exe"] = "0" * 64
        result, _ = self.run_stage(lock)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("manifest.json", self.output())

    def test_changed_bytes_fail(self):
        (self.served / "archestra-darwin-arm64").write_bytes(b"other bytes\n")
        result, _ = self.run_stage(self.lock())
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("manifest.json", self.output())

    def test_download_is_retried_and_then_fails(self):
        result, calls = self.run_stage(self.lock(), failures=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), len(writer.FILES) + 2)
        result, calls = self.run_stage(self.lock(), failures=3)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(calls), 3)
        self.assertIn(f"could not download {URL}/archestra-darwin-arm64", result.stderr)

    def test_malformed_locks_fail_before_any_download(self):
        good = self.lock()
        sha = good["files"]["archestra-linux-arm64"]
        for label, lock in (
            ("version without files", writer.EMPTY | {"version": "0.2.0"}),
            ("files without version", good | {"version": None}),
            ("files without url", good | {"url": None}),
            ("version with a slash", good | {"version": "0.2.0/../x"}),
            ("http url", good | {"url": URL.replace("https://", "http://")}),
            ("url with a slash at the end", good | {"url": URL + "/"}),
            ("url with a space", good | {"url": URL + " x"}),
            ("path in a name", good | {"files": {"../archestra-linux-arm64": sha}}),
            ("unknown name", good | {"files": {"archestra-linux-riscv64": sha}}),
            ("exe for linux", good | {"files": {"archestra-linux-arm64.exe": sha}}),
            ("short checksum", good | {"files": {"archestra-linux-arm64": sha[:-1]}}),
            ("uppercase checksum", good | {"files": {"archestra-linux-arm64": sha.upper()}}),
            ("checksum is not a string", good | {"files": {"archestra-linux-arm64": 1}}),
            ("files is a list", good | {"files": ["archestra-linux-arm64"]}),
            ("files is missing", {"version": None, "url": None}),
            ("not JSON", "{"),
        ):
            with self.subTest(lock=label):
                result, calls = self.run_stage(lock)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])
                self.assertEqual(self.output(), [])


class StageShapeTests(unittest.TestCase):
    def test_stage_reads_only_the_lock_on_a_pinned_native_image(self):
        # assertTrue, not assertIn: a failure must not print the whole Dockerfile.
        self.assertTrue("\nFROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS archestra-cli-release\n" in DOCKERFILE)
        self.assertRegex(DOCKERFILE, r"(?m)^ARG NODE_IMAGE=\S+@sha256:[0-9a-f]{64}$")
        instructions = re.findall(r"^(?:COPY|ADD|ARG|ENV) .*$", STAGE.split("RUN <<", 1)[0], re.M)
        self.assertEqual(instructions, ["COPY archestra-cli/release.lock.json ./release.lock.json"])
        self.assertTrue(STAGE.startswith("WORKDIR /\n"))

    def test_download_is_followed_by_its_checksum_check(self):
        lines = SCRIPT.splitlines()
        download = next(index for index, line in enumerate(lines) if "wget " in line and not line.startswith("#"))
        # The organization's supply-chain policy looks 12 lines ahead.
        self.assertTrue(any('sha256sum -c "$sums"' in line for line in lines[download:download + 12]))

    def test_runtime_image_takes_the_stage_output(self):
        slim = DOCKERFILE.split("\nFROM base AS unified-slim\n", 1)[1].split("\nFROM ", 1)[0]
        # Relative to /app; `unified` is built from this stage, so both get it.
        self.assertTrue(slim.startswith("WORKDIR /app\n"))
        self.assertTrue("\nCOPY --from=archestra-cli-release /out/ ./archestra-cli/\n" in slim)
        self.assertTrue("\nFROM unified-slim AS unified\n" in DOCKERFILE)

    def test_lock_is_in_the_docker_context_and_in_the_tilt_build(self):
        ignore = (ROOT / "platform/.dockerignore").read_text().splitlines()
        self.assertIn("!archestra-cli/release.lock.json", ignore)
        tilt = (ROOT / "platform/dev/Tiltfile.integrations").read_text()
        only = tilt.split("dockerfile='../Dockerfile',\n", 1)[1].split("only=[", 1)[1].split("]", 1)[0]
        self.assertIn("'archestra-cli/release.lock.json'", only)


if __name__ == "__main__":
    unittest.main()
