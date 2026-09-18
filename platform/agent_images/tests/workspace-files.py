"""Exercise the workspace file helper, including streaming transfers.

Runs the real program against a real workspace directory. No mocks and no
network. Covers the bounded JSON path, streaming reads and writes, resume,
snapshot stability, conflict refusal, and symlink refusal.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

def locate_helper():
    """Find the helper in a checkout or in the built image.

    The repository keeps it beside this directory. The image installs it on
    PATH and bind-mounts these tests somewhere unrelated, so neither location
    can be assumed.
    """
    candidates = [
        Path(__file__).resolve().parent.parent / "bin" / "archestra-workspace-files",
        Path("/usr/local/bin/archestra-workspace-files"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise SystemExit("Could not locate archestra-workspace-files")


HELPER = locate_helper()
BLOCK = 1024 * 1024
LARGE_BYTES = 100 * 1024 * 1024


def payload(size, seed=b"seed"):
    """Deterministic incompressible bytes, so checksums catch real corruption."""
    out = bytearray()
    block = hashlib.sha256(seed).digest()
    while len(out) < size:
        block = hashlib.sha256(block).digest()
        out.extend(block)
    return bytes(out[:size])


class WorkspaceFilesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.addCleanup(self.directory.cleanup)

    def run_helper(self, *args, stdin=None, expect_ok=True):
        result = subprocess.run(
            [sys.executable, str(HELPER), *args],
            input=stdin,
            capture_output=True,
            env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ROOT": str(self.root)},
        )
        reply = json.loads(result.stdout)
        if expect_ok:
            self.assertTrue(reply.get("ok"), reply)
        return reply

    def read_range(self, transfer_id, offset, length):
        result = subprocess.run(
            [sys.executable, str(HELPER), "read-range", transfer_id, str(offset), str(length)],
            capture_output=True,
            env={**os.environ, "ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ROOT": str(self.root)},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    # --- the existing bounded path must not regress --------------------

    def test_json_read_and_write_still_work(self):
        data = payload(1024)
        (self.root / "notes").mkdir()
        written = self.run_helper(
            stdin=json.dumps({
                "operation": "write", "path": "notes/one.bin",
                "content_base64": base64.b64encode(data).decode(),
            }).encode()
        )
        self.assertEqual(written["sha256"], hashlib.sha256(data).hexdigest())
        read = self.run_helper(
            stdin=json.dumps({"operation": "read", "path": "notes/one.bin"}).encode()
        )
        self.assertEqual(base64.b64decode(read["content_base64"]), data)

    def test_json_read_still_refuses_oversize_files(self):
        (self.root / "big.bin").write_bytes(payload(5 * 1024 * 1024))
        reply = self.run_helper(
            stdin=json.dumps({"operation": "read", "path": "big.bin"}).encode(),
            expect_ok=False,
        )
        self.assertFalse(reply["ok"])
        self.assertIn("4 MiB", reply["error"])

    def test_traversal_is_refused(self):
        reply = self.run_helper("stat", "../escape", expect_ok=False)
        self.assertFalse(reply["ok"])

    def test_symlinked_parent_is_refused(self):
        (self.root / "real").mkdir()
        os.symlink(self.root / "real", self.root / "link")
        reply = self.run_helper("stat", "link/file.bin", expect_ok=False)
        self.assertFalse(reply["ok"])

    # --- download -------------------------------------------------------

    def test_stat_reports_absence_without_error(self):
        reply = self.run_helper("stat", "missing.bin")
        self.assertFalse(reply["present"])

    def test_snapshot_streams_binary_content_intact(self):
        data = payload(8 * 1024 * 1024)
        (self.root / "build.tar.gz").write_bytes(data)
        snap = self.run_helper("snapshot", "build.tar.gz")
        self.assertEqual(snap["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(snap["size"], len(data))
        self.assertEqual(self.read_range(snap["transfer_id"], 0, -1), data)

    def test_interrupted_download_resumes_without_refetching(self):
        data = payload(8 * 1024 * 1024)
        (self.root / "build.tar.gz").write_bytes(data)
        snap = self.run_helper("snapshot", "build.tar.gz")
        cut = 3 * 1024 * 1024 + 7
        first = self.read_range(snap["transfer_id"], 0, cut)
        self.assertEqual(len(first), cut)
        rest = self.read_range(snap["transfer_id"], cut, -1)
        self.assertEqual(first + rest, data)

    def test_snapshot_survives_the_source_being_replaced(self):
        original = payload(4 * 1024 * 1024, b"original")
        (self.root / "report.bin").write_bytes(original)
        snap = self.run_helper("snapshot", "report.bin")
        head = self.read_range(snap["transfer_id"], 0, BLOCK)
        # The runtime keeps working and replaces the file mid-transfer.
        replacement = payload(4 * 1024 * 1024, b"replacement")
        (self.root / "report.bin.new").write_bytes(replacement)
        os.replace(self.root / "report.bin.new", self.root / "report.bin")
        tail = self.read_range(snap["transfer_id"], BLOCK, -1)
        self.assertEqual(head + tail, original)
        self.assertEqual((self.root / "report.bin").read_bytes(), replacement)

    # --- upload ---------------------------------------------------------

    def test_upload_creates_a_new_file(self):
        data = payload(6 * 1024 * 1024)
        (self.root / "out").mkdir()
        upload = self.run_helper("write-stream", "a" * 32, stdin=data)
        self.assertEqual(upload["sha256"], hashlib.sha256(data).hexdigest())
        self.run_helper("finalize", "a" * 32, "out/build.bin", upload["sha256"], "-", "0")
        self.assertEqual((self.root / "out" / "build.bin").read_bytes(), data)

    def test_upload_refuses_a_missing_parent_directory(self):
        """Parents are never created implicitly, matching the bounded JSON path."""
        upload = self.run_helper("write-stream", "9" * 32, stdin=payload(64))
        reply = self.run_helper(
            "finalize", "9" * 32, "absent/build.bin", upload["sha256"], "-", "0",
            expect_ok=False,
        )
        self.assertFalse(reply["ok"])
        self.assertFalse((self.root / "absent").exists())

    def test_upload_replaces_an_unchanged_file(self):
        (self.root / "target.bin").write_bytes(payload(16, b"old"))
        before = self.run_helper("stat", "target.bin")
        data = payload(2 * 1024 * 1024, b"new")
        upload = self.run_helper("write-stream", "b" * 32, stdin=data)
        self.run_helper(
            "finalize", "b" * 32, "target.bin", upload["sha256"],
            str(before["ino"]), str(before["mtime_ns"]),
        )
        self.assertEqual((self.root / "target.bin").read_bytes(), data)

    def test_upload_refuses_when_the_destination_changed(self):
        (self.root / "target.bin").write_bytes(payload(16, b"old"))
        before = self.run_helper("stat", "target.bin")
        data = payload(1024, b"mine")
        upload = self.run_helper("write-stream", "c" * 32, stdin=data)
        # Someone in the runtime writes that path after the transfer began.
        theirs = payload(32, b"theirs")
        (self.root / "target.bin.new").write_bytes(theirs)
        os.replace(self.root / "target.bin.new", self.root / "target.bin")
        reply = self.run_helper(
            "finalize", "c" * 32, "target.bin", upload["sha256"],
            str(before["ino"]), str(before["mtime_ns"]), expect_ok=False,
        )
        self.assertFalse(reply["ok"])
        self.assertIn("changed", reply["error"])
        self.assertEqual((self.root / "target.bin").read_bytes(), theirs)

    def test_upload_refuses_a_checksum_mismatch(self):
        (self.root / "target.bin").write_bytes(payload(16, b"old"))
        before = self.run_helper("stat", "target.bin")
        self.run_helper("write-stream", "d" * 32, stdin=payload(2048))
        reply = self.run_helper(
            "finalize", "d" * 32, "target.bin", hashlib.sha256(b"wrong").hexdigest(),
            str(before["ino"]), str(before["mtime_ns"]), expect_ok=False,
        )
        self.assertFalse(reply["ok"])
        self.assertIn("checksum", reply["error"])
        self.assertEqual((self.root / "target.bin").read_bytes(), payload(16, b"old"))

    def test_upload_refuses_to_clobber_a_file_that_appeared(self):
        data = payload(1024)
        upload = self.run_helper("write-stream", "e" * 32, stdin=data)
        (self.root / "fresh.bin").write_bytes(payload(8, b"theirs"))
        reply = self.run_helper(
            "finalize", "e" * 32, "fresh.bin", upload["sha256"], "-", "0",
            expect_ok=False,
        )
        self.assertFalse(reply["ok"])
        self.assertEqual((self.root / "fresh.bin").read_bytes(), payload(8, b"theirs"))

    def test_stale_staging_entries_are_swept_but_live_ones_survive(self):
        """An abandoned snapshot holds its inode, so space is never reclaimed."""
        (self.root / "pinned.bin").write_bytes(payload(2048))
        snap = self.run_helper("snapshot", "pinned.bin")
        staging = self.root / ".archestra-transfers"
        stale = staging / ("0" * 32)
        stale.write_bytes(b"abandoned")
        old = time.time() - 7 * 60 * 60
        os.utime(stale, (old, old))
        # Sweeping happens when a transfer opens staging, not on unrelated reads.
        self.run_helper("snapshot", "pinned.bin")
        self.assertFalse(stale.exists(), "a stale entry should be removed")
        self.assertTrue(
            (staging / snap["transfer_id"]).exists(),
            "a recent snapshot must survive",
        )
        self.assertEqual(self.read_range(snap["transfer_id"], 0, -1), payload(2048))

    def test_malformed_transfer_id_is_refused(self):
        reply = self.run_helper("write-stream", "../../etc/passwd", expect_ok=False)
        self.assertFalse(reply["ok"])

    # --- size -------------------------------------------------------------

    def test_large_file_survives_a_round_trip_in_both_directions(self):
        """Well past the 4 MiB the bounded JSON path allows.

        Memory is deliberately not asserted here. Peak resident size is only
        observable through coarse, platform-dependent accounting, and a flaky
        reading of it would block every image build. The helper reads and
        writes in fixed blocks, and throughput and memory are measured
        separately rather than pinned by a test.
        """
        data = payload(LARGE_BYTES)
        digest = hashlib.sha256(data).hexdigest()
        upload = self.run_helper("write-stream", "f" * 32, stdin=data)
        self.assertEqual(upload["sha256"], digest)
        self.run_helper("finalize", "f" * 32, "large.bin", digest, "-", "0")
        snap = self.run_helper("snapshot", "large.bin")
        self.assertEqual(snap["sha256"], digest)
        out = self.read_range(snap["transfer_id"], 0, -1)
        self.assertEqual(len(out), LARGE_BYTES)
        self.assertEqual(hashlib.sha256(out).hexdigest(), digest)


if __name__ == "__main__":
    unittest.main()
