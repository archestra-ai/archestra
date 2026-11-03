"""Exercise upgrade decisions and the CLI against real temporary Git histories."""

import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-migration-upgrades.py").resolve()
SPEC = importlib.util.spec_from_file_location("check_migration_upgrades", SCRIPT)
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


def migration(tag, when, sql=None):
    return {"tag": tag, "when": when, "hash": hashlib.sha256((sql or tag).encode()).hexdigest()}


class UpgradeTest(unittest.TestCase):
    def setUp(self):
        self.common = migration("0000_common", 100)
        self.feature = migration("0001_feature", 200)
        self.backport = migration("0001_backport", 400, "backport")
        self.upstream = migration("0002_upstream", 300, "backport")
        self.repair = migration("0003_repair", 500)
        self.source = [self.common, self.backport]
        self.target = [self.common, self.feature, self.upstream]
        self.coverage = {self.repair["tag"]: {self.feature["tag"]: self.feature["hash"]}}

    def test_monotonic_tracks_can_still_skip_a_feature(self):
        errors = checker.upgrade_errors(self.source, self.target, {})
        self.assertEqual(len(errors), 1)
        self.assertIn("Drizzle skips 0001_feature", errors[0])

    def test_new_repair_covers_the_gap_and_renamed_backport_is_recognized(self):
        self.assertEqual(checker.upgrade_errors(self.source, self.target + [self.repair], self.coverage), [])

    def test_repair_below_source_watermark_does_not_cover_gap(self):
        source = self.source + [migration("later", 600)]
        target = self.target + [self.repair, source[-1]]
        errors = checker.upgrade_errors(source, target, self.coverage)
        self.assertTrue(any("skips 0001_feature" in error for error in errors))

    def test_previously_applied_repair_covers_gap(self):
        self.assertEqual(checker.upgrade_errors(self.source + [self.repair], self.target + [self.repair], self.coverage), [])

    def test_changed_covered_sql_invalidates_repair(self):
        changed = dict(self.feature, hash="changed")
        errors = checker.upgrade_errors(self.source, [self.common, changed, self.upstream, self.repair], self.coverage)
        self.assertTrue(any("does not match its SQL" in error for error in errors))
        self.assertTrue(any("skips 0001_feature" in error for error in errors))

    def test_unknown_or_older_repair_fails(self):
        errors = checker.upgrade_errors(self.source, self.target, self.coverage)
        self.assertTrue(any("Unknown repair" in error for error in errors))
        older = dict(self.repair, when=150)
        errors = checker.upgrade_errors(self.source, self.target + [older], self.coverage)
        self.assertTrue(any("repair must be newer" in error for error in errors))

    def test_equal_timestamp_is_skipped(self):
        feature = dict(self.feature, when=self.backport["when"])
        self.assertTrue(any("skips 0001_feature" in error for error in checker.upgrade_errors(self.source, [self.common, feature, self.upstream], {})))

    def test_timestamp_change_that_replays_backport_fails(self):
        upstream = dict(self.upstream, when=450)
        errors = checker.upgrade_errors(self.source, [self.common, upstream], {})
        self.assertTrue(any("replays already-applied SQL" in error for error in errors))

    def test_missing_source_migration_fails(self):
        errors = checker.upgrade_errors(self.source, [self.common], {})
        self.assertTrue(any("no SQL-equivalent migration" in error for error in errors))

    def test_fresh_and_normal_incremental_upgrades_pass(self):
        self.assertEqual(checker.upgrade_errors([], self.target, {}), [])
        self.assertEqual(checker.upgrade_errors([self.common], self.target, {}), [])


class CliTest(unittest.TestCase):
    def test_release_track_checks_fail_before_repair_and_pass_after(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / checker.MIGRATIONS
            (folder / "meta").mkdir(parents=True)

            def git(*args):
                return subprocess.check_output(["git", "-C", directory, *args], stderr=subprocess.STDOUT)

            def history(entries):
                (folder / "meta/_journal.json").write_text(json.dumps({"entries": entries}))
                for entry in entries:
                    (folder / (entry["tag"] + ".sql")).write_text(entry["tag"])

            def run(*args):
                return subprocess.run(["python3", str(SCRIPT), *args], cwd=root / "platform", capture_output=True, text=True)

            git("init", "-q")
            git("config", "user.email", "test@example.com")
            git("config", "user.name", "Test")
            common = {"tag": "common", "when": 100}
            backport = {"tag": "backport", "when": 400}
            feature = {"tag": "feature", "when": 200}
            repair = {"tag": "repair", "when": 500}
            history([common, backport])
            git("add", ".")
            git("commit", "-qm", "stable")
            git("update-ref", "refs/remotes/origin/release/1.3", "HEAD")
            history([common, feature, backport])
            git("add", ".")
            git("commit", "-qm", "main")
            git("update-ref", "refs/remotes/origin/main", "HEAD")
            result = run("--base-branch", "main")
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Drizzle skips feature", result.stdout)
            history([common, feature, backport, repair])
            (folder / "upgrade-repairs.json").write_text(json.dumps({"repair": {"feature": hashlib.sha256(b"feature").hexdigest()}}))
            result = run("--base-branch", "main")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            git("add", ".")
            git("commit", "-qm", "repair")
            git("update-ref", "refs/remotes/origin/main", "HEAD")
            git("checkout", "--detach", "origin/release/1.3")
            result = run("--base-branch", "release/1.3")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("WORKTREE -> origin/main", result.stdout)
            result = run("--source-ref", "missing-ref")
            self.assertNotEqual(result.returncode, 0)
            git("update-ref", "-d", "refs/remotes/origin/release/1.3")
            result = run("--base-branch", "main")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("No stable release refs", result.stderr)


if __name__ == "__main__":
    unittest.main()
