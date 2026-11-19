"""Check the archestra version-bump rule: the decision alone, then real Git with a fake `gh`."""

import importlib.util
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("archestra-cli-version-check.py")
ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ".github/workflows/build-archestra-cli.yml"
SPEC = importlib.util.spec_from_file_location("archestra_cli_version_check", SCRIPT)
check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check)

CLI = "platform/archestra-cli/"
MANIFEST = '[workspace]\n\n[package]\nname = "archestra_cli"\nversion = "{}"\n\n[dependencies]\nserde = {{ version = "1" }}\n'


class BinaryInputTests(unittest.TestCase):
    def test_sources_and_manifests_reach_the_binary(self):
        for path in (
            CLI + "src/main.rs", CLI + "src/bridge/tray/macos.rs", CLI + "Cargo.toml", CLI + "Cargo.lock",
            CLI + "build.rs", CLI + ".cargo/config.toml", CLI + "assets/icon.ico",
        ):
            with self.subTest(path=path):
                self.assertTrue(check.binary_input(path))

    def test_prose_tests_the_release_lock_and_other_trees_do_not(self):
        for path in (
            CLI + "README.md", CLI + "src/bridge/NOTES.md", CLI + "tests/integration/main.rs",
            CLI + "tests/fixtures/server.py", CLI + "release.lock.json",
            "platform/archestra-rs/Cargo.toml", "platform/archestra-cli-notes/src/main.rs",
            "platform/backend/src/routes/archestra-cli/archestra-cli.routes.ts",
            WORKFLOW, ".github/scripts/archestra-cli-version-check.py", "rust-toolchain.toml",
            # The compiler that the platform shares: a new one alone is not a
            # new program for the devices.
            "platform/rust-toolchain.toml",
        ):
            with self.subTest(path=path):
                self.assertFalse(check.binary_input(path))


class ChangedInputTests(unittest.TestCase):
    def test_name_status_output_is_split_into_entries(self):
        output = "M\0a.rs\0R100\0old.rs\0new.rs\0A\0b c.rs\0R087\0x.rs\0y.rs\0D\0gone.rs\0"
        self.assertEqual(check.parse_name_status(output), [
            ("M", ["a.rs"]), ("R100", ["old.rs", "new.rs"]), ("A", ["b c.rs"]),
            ("R087", ["x.rs", "y.rs"]), ("D", ["gone.rs"]),
        ])
        self.assertEqual(check.parse_name_status(""), [])

    def test_only_binary_inputs_are_reported(self):
        entries = [
            ("M", [CLI + "src/main.rs"]), ("A", [CLI + "README.md"]), ("D", [CLI + "src/old.rs"]),
            ("M", [CLI + "tests/integration/main.rs"]), ("M", ["platform/backend/src/server.ts"]),
        ]
        self.assertEqual(check.changed_inputs(entries), [CLI + "src/main.rs", CLI + "src/old.rs"])

    def test_pure_renames_are_exempt_and_edited_renames_count_under_both_names(self):
        moved = [("R100", [CLI + "src/a.rs", "platform/program/src/a.rs"]),
                 ("R100", [CLI + "Cargo.toml", "platform/program/Cargo.toml"])]
        self.assertEqual(check.changed_inputs(moved), [])
        self.assertEqual(
            check.changed_inputs([("R096", [CLI + "src/a.rs", CLI + "src/b.rs"])]),
            [CLI + "src/a.rs", CLI + "src/b.rs"],
        )
        # An edited file that leaves the inputs still changes the binary.
        self.assertEqual(
            check.changed_inputs([("R090", [CLI + "src/a.rs", CLI + "tests/a.rs"])]), [CLI + "src/a.rs"],
        )


class VersionTests(unittest.TestCase):
    def test_package_version_is_read_from_the_package_table(self):
        manifest = '[workspace]\n[package]\nname = "archestra_cli"\nversion = "0.3.1"\n[dependencies]\nserde = { version = "1" }\n'
        self.assertEqual(check.package_version(manifest), "0.3.1")

    def test_a_manifest_without_a_literal_version_is_an_error(self):
        for manifest in ('[package]\nname = "x"\n', '[package]\nversion = { workspace = true }\n',
                         '[dependencies]\nserde = { version = "1" }\n'):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                check.package_version(manifest)

    def test_repository_manifest_has_a_version_the_script_reads(self):
        version = check.package_version((ROOT / check.MANIFEST).read_text())
        self.assertRegex(version, r"^\d+\.\d+\.\d+")
        printed = subprocess.check_output([sys.executable, str(SCRIPT), "version"], text=True).strip()
        self.assertEqual(printed, version)


class VerdictTests(unittest.TestCase):
    CHANGED = [CLI + "Cargo.lock", CLI + "src/main.rs"]

    def test_no_binary_input_change_passes_even_for_a_released_version(self):
        passed, message = check.verdict([], "0.1.0", True)
        self.assertTrue(passed)
        self.assertIn("no version bump", message)

    def test_change_under_an_unreleased_version_passes(self):
        passed, message = check.verdict(self.CHANGED, "0.2.0", False)
        self.assertTrue(passed)
        self.assertIn("archestra-cli-v0.2.0", message)

    def test_removed_program_passes(self):
        self.assertTrue(check.verdict(self.CHANGED, None, False)[0])

    def test_change_under_a_released_version_fails_and_says_what_to_do(self):
        passed, message = check.verdict(self.CHANGED, "0.1.9", True)
        self.assertFalse(passed)
        for expected in (
            "0.1.9 is already released as archestra-cli-v0.1.9",
            "  platform/archestra-cli/Cargo.lock\n  platform/archestra-cli/src/main.rs\n",
            "Raise `version` under [package] in platform/archestra-cli/Cargo.toml",
            '(for example to "0.1.10")',
            "Run `cargo check` in platform/archestra-cli",
            "--locked",
            "Commit Cargo.toml and Cargo.lock",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, message)

    def test_a_prerelease_version_gets_no_invented_example(self):
        passed, message = check.verdict(self.CHANGED, "1.0.0-rc.1", True)
        self.assertFalse(passed)
        self.assertNotIn("for example", message)
        self.assertIn("archestra-cli-v1.0.0-rc.1", message)


class CheckTests(unittest.TestCase):
    """The command against real commits. `gh` is the only fake."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.binaries = Path(self.temp.name) / "bin"
        self.binaries.mkdir()
        self.calls = Path(self.temp.name) / "gh-calls"
        # Answers per API path prefix: exit 0, or a 404, or another failure.
        gh = self.binaries / "gh"
        gh.write_text(
            "#!/bin/bash\n"
            'printf "%s\\n" "$2" >> "$ARCHESTRA_TEST_GH_CALLS"\n'
            'case "$2" in\n'
            '  repos/fixture/repository/releases/tags/*) answer="$ARCHESTRA_TEST_RELEASE" ;;\n'
            '  repos/fixture/repository/git/ref/tags/*) answer="$ARCHESTRA_TEST_TAG" ;;\n'
            '  *) answer=unexpected ;;\n'
            "esac\n"
            'case "$answer" in\n'
            "  found) exit 0 ;;\n"
            '  missing) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\n'
            '  *) echo "gh: Server Error (HTTP 502)" >&2; exit 1 ;;\n'
            "esac\n"
        )
        gh.chmod(0o755)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI")
        self.write(CLI + "Cargo.toml", MANIFEST.format("0.1.0"))
        self.write(CLI + "src/main.rs", "fn main() {}\n" * 20)
        self.write(CLI + "README.md", "# archestra\n")
        self.write(CLI + "tests/integration/main.rs", "#[test]\nfn works() {}\n")
        self.write(CLI + "release.lock.json", "{}\n")
        self.write("platform/rust-toolchain.toml", '[toolchain]\nchannel = "1.93.0"\n')
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def write(self, name, content):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-qm", "change")
        return self.git("rev-parse", "HEAD")

    def run_check(self, release="missing", tag="missing", base=None):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "check", base or self.base, "HEAD"],
            cwd=self.repo, capture_output=True, text=True,
            env=os.environ | {
                "PATH": f"{self.binaries}:{os.environ['PATH']}",
                "GITHUB_REPOSITORY": "fixture/repository", "GITHUB_ACTIONS": "true",
                "ARCHESTRA_TEST_GH_CALLS": str(self.calls),
                "ARCHESTRA_TEST_RELEASE": release, "ARCHESTRA_TEST_TAG": tag,
            },
        )
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        self.calls.unlink(missing_ok=True)
        return result, calls

    def test_source_change_under_a_released_version_fails(self):
        self.write(CLI + "src/main.rs", "fn main() { println!(); }\n")
        self.commit()
        result, calls = self.run_check(release="found")
        self.assertEqual(result.returncode, 1)
        self.assertIn("::error title=Version bump required::", result.stdout)
        self.assertIn("platform/archestra-cli/src/main.rs", result.stderr)
        self.assertEqual(calls, ["repos/fixture/repository/releases/tags/archestra-cli-v0.1.0"])

    def test_a_tag_without_a_release_counts_as_released(self):
        self.write(CLI + "Cargo.lock", "# a dependency moved\n")
        self.commit()
        result, calls = self.run_check(release="missing", tag="found")
        self.assertEqual(result.returncode, 1)
        self.assertIn("platform/archestra-cli/Cargo.lock", result.stderr)
        self.assertEqual(len(calls), 2)

    def test_a_new_compiler_alone_needs_no_bump(self):
        self.write("platform/rust-toolchain.toml", '[toolchain]\nchannel = "1.94.0"\n')
        self.commit()
        result, calls = self.run_check(release="found")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_source_change_with_a_bumped_unreleased_version_passes(self):
        self.write(CLI + "src/main.rs", "fn main() { println!(); }\n")
        self.write(CLI + "Cargo.toml", MANIFEST.format("0.2.0"))
        self.commit()
        result, calls = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("archestra-cli-v0.2.0", result.stdout)
        self.assertEqual(calls, [
            "repos/fixture/repository/releases/tags/archestra-cli-v0.2.0",
            "repos/fixture/repository/git/ref/tags/archestra-cli-v0.2.0",
        ])

    def test_prose_tests_and_lock_changes_pass_without_asking_github(self):
        self.write(CLI + "README.md", "# archestra\n\nMore words.\n")
        self.write(CLI + "tests/integration/main.rs", "#[test]\nfn still_works() {}\n")
        self.write(CLI + "release.lock.json", '{"version": "0.1.0"}\n')
        self.write("platform/backend/src/server.ts", "export {};\n")
        self.commit()
        result, calls = self.run_check(release="found", tag="found")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])

    def test_moving_the_program_unchanged_passes_and_an_edited_move_fails(self):
        self.git("mv", "platform/archestra-cli", "platform/program")
        moved = self.commit()
        result, calls = self.run_check(release="found")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])
        self.git("mv", "platform/program", "platform/archestra-cli")
        self.write(CLI + "src/main.rs", "fn main() {}\n" * 19 + "fn other() {}\n")
        self.commit()
        result, _ = self.run_check(release="found", base=moved)
        self.assertEqual(result.returncode, 1)
        self.assertIn("platform/archestra-cli/src/main.rs", result.stderr)

    def test_a_failed_request_never_passes_the_check(self):
        self.write(CLI + "src/main.rs", "fn main() { println!(); }\n")
        self.commit()
        for release, tag in (("broken", "missing"), ("missing", "broken")):
            with self.subTest(release=release, tag=tag):
                result, _ = self.run_check(release=release, tag=tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("HTTP 502", result.stderr)

    def test_deleting_the_program_passes(self):
        self.git("rm", "-rq", "platform/archestra-cli")
        self.commit()
        result, calls = self.run_check(release="found")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [])


def path_filter_matches(patterns, path):
    """GitHub's `paths` filter: the last pattern that matches decides."""
    matched = False
    for pattern in patterns:
        negated = pattern.startswith("!")
        expression = re.escape(pattern.lstrip("!")).replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
        if re.fullmatch(expression, path):
            matched = not negated
    return matched


class WorkflowTriggerTests(unittest.TestCase):
    """The workflow's path filters start it for the binary's inputs and itself."""

    def setUp(self):
        workflow = (ROOT / WORKFLOW).read_text()
        triggers = workflow.split("\non:\n", 1)[1].split("\npermissions:", 1)[0]
        self.filters = [
            re.findall(r'^      - "(.*)"$', block, re.M)
            for block in triggers.split("    paths:\n")[1:]
        ]

    def test_push_and_pull_request_filters_are_the_same_list(self):
        self.assertEqual(len(self.filters), 2)
        self.assertEqual(self.filters[0], self.filters[1])
        self.assertTrue(self.filters[0])

    def test_filters_agree_with_the_version_check(self):
        for path in (
            CLI + "src/main.rs", CLI + "src/bridge/tray/windows.rs", CLI + "Cargo.toml", CLI + "Cargo.lock",
            CLI + "build.rs", CLI + ".cargo/config.toml", "platform/rust-toolchain.toml",
            CLI + "README.md", CLI + "src/NOTES.md", CLI + "tests/integration/main.rs",
            CLI + "tests/fixtures/README.md", CLI + "release.lock.json",
            "platform/archestra-rs/Cargo.toml", "platform/Dockerfile", "README.md",
            ".github/scripts/archestra-cli-version-check.py",
        ):
            with self.subTest(path=path):
                self.assertEqual(path_filter_matches(self.filters[0], path), check.binary_input(path))
        self.assertTrue(path_filter_matches(self.filters[0], WORKFLOW))


if __name__ == "__main__":
    unittest.main()
