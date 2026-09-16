import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

SPEC = importlib.util.spec_from_file_location(
    "check_cargo_release_age", Path(__file__).with_name("check-cargo-release-age.py")
)
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
NOW = datetime(2026, 9, 16, tzinfo=UTC)


def lockfile(*packages):
    return (
        "version = 4\npackage = []\n"
        if not packages
        else "version = 4\n"
        + "".join(
            f'[[package]]\nname = "{name}"\nversion = "{version}"\n'
            + (f'source = "{source}"\n' if source else "")
            for name, version, source in packages
        )
    )


def registry_response(published, name="example", version="1.0.0"):
    return io.BytesIO(
        json.dumps(
            {
                "version": {
                    "crate": name,
                    "num": version,
                    "created_at": published,
                }
            }
        ).encode()
    )


class ReleaseAgeTests(unittest.TestCase):
    def test_exact_seven_day_boundary(self):
        current = lockfile(("example", "1.0.0", policy.CRATES_IO))
        for age, blocked in [
            (timedelta(days=7), False),
            (timedelta(days=7, seconds=-1), True),
            (timedelta(days=-1), True),
        ]:
            with (
                self.subTest(age=age),
                patch.object(
                    policy,
                    "urlopen",
                    return_value=registry_response((NOW - age).isoformat()),
                ),
            ):
                self.assertEqual(
                    bool(policy.check_versions(lockfile(), current, NOW)), blocked
                )

    def test_unchanged_removed_and_local_or_git_packages_need_no_lookup(self):
        existing = ("example", "1.0.0", policy.CRATES_IO)
        base = lockfile(existing, ("removed", "1.0.0", policy.CRATES_IO))
        current = lockfile(
            existing,
            ("local", "1.0.0", None),
            ("git", "1.0.0", "git+https://example.com/repo#abc"),
        )
        with patch.object(policy, "urlopen") as fetch:
            self.assertEqual(policy.check_versions(base, current, NOW), [])
            fetch.assert_not_called()

    def test_checks_new_version_of_existing_crate_and_transitive_package(self):
        base = lockfile(("example", "0.9.0", policy.CRATES_IO))
        current = lockfile(
            ("example", "1.0.0", policy.CRATES_IO),
            ("transitive", "1.0.0", policy.CRATES_IO),
        )
        with patch.object(
            policy,
            "urlopen",
            side_effect=[
                registry_response(NOW.isoformat()),
                registry_response(NOW.isoformat(), name="transitive"),
            ],
        ) as fetch:
            failures = policy.check_versions(base, current, NOW)
        self.assertEqual(len(failures), 2)
        self.assertEqual(fetch.call_count, 2)
        self.assertIn("transitive@1.0.0", failures[1])

    def test_unknown_registry_fails_without_contacting_it(self):
        with patch.object(policy, "urlopen") as fetch:
            failures = policy.check_versions(
                lockfile(),
                lockfile(("example", "1.0.0", "sparse+https://example.com/index")),
                NOW,
            )
            self.assertIn("unsupported registry", failures[0])
            fetch.assert_not_called()

    def test_invalid_metadata_and_network_errors_fail_closed(self):
        for response in [
            b"{}",
            b"not json",
            registry_response("invalid").getvalue(),
            registry_response("2026-01-01T00:00:00").getvalue(),
            registry_response(NOW.isoformat(), name="wrong").getvalue(),
        ]:
            with (
                self.subTest(response=response),
                patch.object(policy, "urlopen", return_value=io.BytesIO(response)),
                self.assertRaises((KeyError, ValueError)),
            ):
                policy.publication_time("example", "1.0.0")
        with (
            patch.object(policy, "urlopen", side_effect=URLError("unavailable")),
            self.assertRaises(URLError),
        ):
            policy.check_versions(
                lockfile(), lockfile(("example", "1.0.0", policy.CRATES_IO)), NOW
            )

    def test_cli_reads_real_git_baseline_and_rejects_missing_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            (root / "Cargo.lock").write_text(lockfile(("local", "1.0.0", None)))
            subprocess.run(["git", "-C", directory, "add", "Cargo.lock"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    directory,
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "commit",
                    "-qm",
                    "baseline",
                ],
                check=True,
            )
            for base, expected in [("HEAD", 0), ("missing-base", 1)]:
                result = subprocess.run(
                    [
                        "python3",
                        str(Path(policy.__file__).resolve()),
                        "--base-ref",
                        base,
                        "--lockfile",
                        "Cargo.lock",
                    ],
                    cwd=root,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_command_fails_for_young_release_or_unavailable_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "Cargo.lock").write_text(
                lockfile(("example", "1.0.0", policy.CRATES_IO))
            )
            for failure in [False, True]:
                with (
                    self.subTest(network_failure=failure),
                    patch.object(
                        policy.subprocess,
                        "check_output",
                        side_effect=[directory, lockfile()],
                    ),
                    patch.object(
                        policy.sys,
                        "argv",
                        ["check", "--base-ref", "base", "--lockfile", "Cargo.lock"],
                    ),
                    patch.object(
                        policy,
                        "urlopen",
                        side_effect=URLError("unavailable") if failure else None,
                        return_value=registry_response("2999-01-01T00:00:00Z"),
                    ),
                    patch.object(
                        policy.sys, "stderr", new_callable=io.StringIO
                    ) as stderr,
                ):
                    self.assertEqual(policy.main(), 1)
                    self.assertIn(
                        "Cannot verify" if failure else "eligible", stderr.getvalue()
                    )


if __name__ == "__main__":
    unittest.main()
