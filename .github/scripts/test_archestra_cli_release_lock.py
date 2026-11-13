"""Check the archestra release lock writer against real files and `sha256sum` text."""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("archestra-cli-release-lock.py")
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("archestra_cli_release_lock", SCRIPT)
writer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(writer)

SIX = (
    "archestra-darwin-arm64", "archestra-darwin-x86_64", "archestra-linux-arm64",
    "archestra-linux-x86_64", "archestra-windows-arm64.exe", "archestra-windows-x86_64.exe",
)


def content(name):
    return f"binary of {name}\n".encode()


def checksum(name):
    return hashlib.sha256(content(name)).hexdigest()


class LockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = self.root / "dist"
        self.files.mkdir()
        for name in SIX:
            (self.files / name).write_bytes(content(name))
        self.output = self.root / "release.lock.json"

    def run_writer(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--output", str(self.output), *args],
            capture_output=True, text=True,
        )

    def sums(self, names=SIX):
        return "".join(f"{checksum(name)}  {name}\n" for name in names)

    def test_the_six_served_names(self):
        self.assertEqual(writer.FILES, SIX)

    def test_directory_of_six_files_gives_the_lock(self):
        result = self.run_writer("--version", "0.2.0", "--dir", str(self.files))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.output.read_text()), {
            "version": "0.2.0",
            "url": "https://github.com/archestra-ai/archestra/releases/download/archestra-cli-v0.2.0",
            "files": {name: checksum(name) for name in SIX},
        })

    def test_output_is_sorted_indented_and_ends_with_one_newline(self):
        self.run_writer("--version", "0.2.0", "--dir", str(self.files))
        text = self.output.read_text()
        lines = text.splitlines()
        self.assertEqual(lines[:2], ["{", '  "files": {'])
        self.assertEqual(lines[2], f'    "archestra-darwin-arm64": "{checksum("archestra-darwin-arm64")}",')
        self.assertEqual(lines[-3:], [
            '  "url": "https://github.com/archestra-ai/archestra/releases/download/archestra-cli-v0.2.0",',
            '  "version": "0.2.0"', "}",
        ])
        self.assertTrue(text.endswith("}\n") and not text.endswith("\n\n"))

    def test_sums_file_and_directory_give_the_same_bytes(self):
        self.run_writer("--version", "0.2.0", "--dir", str(self.files))
        from_directory = self.output.read_bytes()
        # Any order, and the `*` that `sha256sum -b` prints before a name.
        listed = self.root / "SHA256SUMS"
        listed.write_text("".join(f"{checksum(name)} *{name}\n" for name in reversed(SIX)) + "\n")
        result = self.run_writer("--version", "0.2.0", "--sums", str(listed))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.output.read_bytes(), from_directory)

    def test_directory_may_hold_its_own_sums_file_when_it_agrees(self):
        (self.files / "SHA256SUMS").write_text(self.sums())
        self.assertEqual(self.run_writer("--version", "0.2.0", "--dir", str(self.files)).returncode, 0)
        (self.files / "SHA256SUMS").write_text(
            self.sums().replace(checksum("archestra-linux-arm64"), "0" * 64)
        )
        self.output.unlink()
        result = self.run_writer("--version", "0.2.0", "--dir", str(self.files))
        self.assertEqual(result.returncode, 1)
        self.assertIn("SHA256SUMS does not agree", result.stderr)
        self.assertFalse(self.output.exists())

    def test_missing_file_is_refused(self):
        (self.files / "archestra-windows-arm64.exe").unlink()
        listed = self.root / "SHA256SUMS"
        listed.write_text(self.sums(SIX[:4] + SIX[5:]))
        for source in (("--dir", str(self.files)), ("--sums", str(listed))):
            with self.subTest(source=source[0]):
                result = self.run_writer("--version", "0.2.0", *source)
                self.assertEqual(result.returncode, 1)
                self.assertIn("missing: archestra-windows-arm64.exe", result.stderr)
                self.assertFalse(self.output.exists())

    def test_unexpected_file_is_refused(self):
        (self.files / "archestra-linux-riscv64").write_bytes(b"extra")
        listed = self.root / "SHA256SUMS"
        listed.write_text(self.sums() + f"{'a' * 64}  archestra-linux-riscv64\n")
        for source in (("--dir", str(self.files)), ("--sums", str(listed))):
            with self.subTest(source=source[0]):
                result = self.run_writer("--version", "0.2.0", *source)
                self.assertEqual(result.returncode, 1)
                self.assertIn("unexpected: archestra-linux-riscv64", result.stderr)
                self.assertFalse(self.output.exists())

    def test_a_directory_in_the_place_of_a_file_is_refused(self):
        (self.files / "archestra-linux-arm64").unlink()
        (self.files / "archestra-linux-arm64").mkdir()
        result = self.run_writer("--version", "0.2.0", "--dir", str(self.files))
        self.assertEqual(result.returncode, 1)
        self.assertIn("Not a regular file: archestra-linux-arm64", result.stderr)

    def test_malformed_sums_are_refused(self):
        listed = self.root / "SHA256SUMS"
        for text, expected in (
            (self.sums().replace(checksum(SIX[0]), "XYZ"), "Not a `sha256sum` line"),
            (self.sums().replace(checksum(SIX[0]), checksum(SIX[0]).upper()), "Not a `sha256sum` line"),
            (self.sums() + self.sums(SIX[:1]), "archestra-darwin-arm64 is listed twice"),
        ):
            with self.subTest(expected=expected):
                listed.write_text(text)
                result = self.run_writer("--version", "0.2.0", "--sums", str(listed))
                self.assertEqual(result.returncode, 1)
                self.assertIn(expected, result.stderr)

    def test_version_must_be_a_plain_version(self):
        for version in ("v0.2.0", "archestra-cli-v0.2.0", "0.2", "0.2.0/../x", ""):
            with self.subTest(version=version):
                result = self.run_writer("--version", version, "--dir", str(self.files))
                self.assertEqual(result.returncode, 1)
                self.assertIn("Version must look like 1.2.3", result.stderr)
        self.assertEqual(self.run_writer("--version", "1.0.0-rc.1", "--dir", str(self.files)).returncode, 0)

    def test_repository_selects_the_release_url(self):
        result = self.run_writer("--version", "0.2.0", "--dir", str(self.files), "--repository", "fork/archestra")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(self.output.read_text())["url"],
            "https://github.com/fork/archestra/releases/download/archestra-cli-v0.2.0",
        )
        self.assertEqual(self.run_writer(
            "--version", "0.2.0", "--dir", str(self.files), "--repository", "not a repository",
        ).returncode, 1)

    def test_committed_lock_is_empty_or_what_the_writer_writes(self):
        text = writer.LOCK.read_text()
        lock = json.loads(text)
        self.assertEqual(text, writer.render(lock))
        if lock != writer.EMPTY:
            self.assertEqual(lock, writer.build(lock["version"], lock["files"]))


if __name__ == "__main__":
    unittest.main()
