import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "release_policy", Path(__file__).with_name("release-policy.py")
)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class ReleasePolicyTests(unittest.TestCase):
    def test_complete_release_cycle(self):
        for branch, current, requested, latest in [
            ("release/1.4", "1.3.49", "1.4.0-rc.1", "1.3.49"),
            ("release/1.4", "1.4.0-rc.1", "1.4.0-rc.2", "1.3.50"),
            ("release/1.3", "1.3.49", "1.3.50", "1.3.49"),
            ("release/1.4", "1.4.0-rc.2", "1.4.0", "1.3.50"),
            ("release/1.4", "1.4.0", "1.4.0", "1.3.50"),
            ("release/1.4", "1.4.0", "1.4.1", "1.4.0"),
            ("release/1.4", "1.4.0", "1.4.1", "1.3.50"),  # Rejected final draft.
            ("release/1.4", "1.4.2", "1.4.3", "1.4.1"),  # Rejected patch draft.
            ("release/2.0", "1.4.1", "2.0.0-rc.1", "1.4.1"),
        ]:
            with self.subTest(requested=requested):
                policy.validate_request(branch, current, requested)
                policy.validate_supported(requested, latest)

    def test_invalid_transitions(self):
        for branch, current, requested in [
            ("main", "1.3.49", "1.3.50"),
            ("release/1.3", "1.3.49", "1.4.0-rc.1"),
            ("release/1.4", "1.3.49", "1.4.0"),
            ("release/1.4", "1.4.0-rc.1", "1.4.0-rc.3"),
            ("release/1.4", "1.4.0", "1.4.2"),
            ("release/1.4", "1.4.0", "1.4.0-rc.1"),
            ("release/1.5", "1.3.49", "1.5.0-rc.1"),
        ]:
            with self.subTest(requested=requested), self.assertRaises(ValueError):
                policy.validate_request(branch, current, requested)

    def test_retired_and_future_lines_cannot_publish(self):
        for requested in ("1.3.51", "1.4.0-rc.2", "1.4.0", "1.6.0-rc.1"):
            with self.subTest(requested=requested), self.assertRaises(ValueError):
                policy.validate_supported(requested, "1.4.1")

    def test_version_validation_is_strict(self):
        for value in (
            "dev",
            "v1.4.0",
            "01.4.0",
            "1.4.0-beta.1",
            "1.4.0-rc.0",
            "1.4.0\n",
            "1.4.0;echo unsafe",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.version(value)

    def publication(self):
        return {
            "requested": "1.4.0",
            "latest": "1.3.50",
            "branch": "release/1.4",
            "tag_sha": "a" * 40,
            "run": {
                "path": ".github/workflows/release-please.yml",
                "head_branch": "release/1.4",
                "head_sha": "a" * 40,
                "event": "push",
                "status": "completed",
                "conclusion": "success",
            },
            "release": {
                "tag_name": "platform-v1.4.0",
                "draft": True,
                "prerelease": False,
            },
        }

    def test_exact_successful_build_can_publish(self):
        policy.validate_publication(**self.publication())

    def test_wrong_or_incomplete_build_cannot_publish(self):
        for key, value in {
            "path": ".github/workflows/other.yml",
            "head_branch": "main",
            "head_sha": "b" * 40,
            "event": "pull_request",
            "status": "in_progress",
            "conclusion": "failure",
        }.items():
            args = self.publication()
            args["run"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                policy.validate_publication(**args)

    def test_rc_cannot_publish_as_stable(self):
        args = self.publication()
        args["requested"] = "1.4.0-rc.1"
        with self.assertRaises(ValueError):
            policy.validate_publication(**args)

    def test_retry_current_release_but_not_retired_release(self):
        args = self.publication()
        args["release"]["draft"] = False
        args["latest"] = "1.4.0"
        policy.validate_publication(**args)
        args["latest"] = "1.4.1"
        with self.assertRaises(ValueError):
            policy.validate_publication(**args)


class BackportTests(unittest.TestCase):
    def check(
        self,
        *,
        title="fix: repair behavior",
        body="",
        files="platform/backend/src/example.ts",
        current="1.4.0",
        requested="1.4.0",
    ):
        event = {
            "pull_request": {
                "base": {"ref": "release/1.4", "sha": "a" * 40},
                "head": {"sha": "b" * 40},
                "title": title,
                "body": body,
            }
        }
        with patch.object(
            policy.subprocess,
            "check_output",
            side_effect=[
                json.dumps({"platform": current}),
                json.dumps({"packages": {"platform": {"release-as": requested}}}),
                files,
            ],
        ):
            policy.check_pr(event)

    def test_backport_verifies_original_is_on_main(self):
        original = "c" * 40
        with patch.object(policy.subprocess, "run") as run:
            self.check(body=f"Backport-of: {original}")
            run.assert_called_once_with(
                ["git", "merge-base", "--is-ancestor", original, "origin/main"],
                check=True,
            )

    def test_feature_refactor_breaking_and_unreferenced_prs_fail(self):
        for title in (
            "feat: new behavior",
            "refactor(core): change internals",
            "fix!: break API",
            "fix: repair behavior",
        ):
            with self.subTest(title=title), self.assertRaises(ValueError):
                self.check(title=title)

    def test_patch_migrations_and_final_product_changes_fail(self):
        with self.assertRaisesRegex(ValueError, "schema"):
            self.check(files="platform/backend/src/database/migrations/0001.sql")
        with self.assertRaisesRegex(ValueError, "Final-version"):
            self.check(current="1.4.0-rc.1", requested="1.4.0")

    def test_version_only_pr_needs_no_backport_reference(self):
        self.check(
            current="1.4.0-rc.1", requested="1.4.0", files="platform/package.json"
        )


class QualificationTests(unittest.TestCase):
    def setUp(self):
        # Use the real issue template labels to catch template/validator drift.
        template = (
            Path(__file__).parents[1] / "ISSUE_TEMPLATE/release-qualification.yml"
        ).read_text()
        labels = [
            line.split("- label: ", 1)[1]
            for line in template.splitlines()
            if "- label: " in line
        ]
        self.body = (
            "### Stable version\n\n1.4.0\n\n### Artifact manifest SHA-256\n\n"
            + "a" * 64
            + "\n\n### Upgrade source version\n\n1.3.50\n\n### Qualification\n\n"
            + "\n".join(f"- [x] {label}" for label in labels)
        )

    def test_completed_qualification(self):
        policy.validate_qualification({"body": self.body}, "1.4.0", "1.3.50", "a" * 64)

    def test_unchecked_missing_or_wrong_evidence_rejected(self):
        for body in (
            self.body.replace("[x]", "[ ]", 1),
            self.body.replace("1.4.0", "1.4.1"),
            self.body.replace("a" * 64, "b" * 64),
            self.body.replace("1.3.50", "1.3.49"),
        ):
            with self.subTest(body=body), self.assertRaises(ValueError):
                policy.validate_qualification(
                    {"body": body}, "1.4.0", "1.3.50", "a" * 64
                )

    def test_published_release_retry_does_not_require_upgrade_from_itself(self):
        policy.validate_qualification({"body": self.body}, "1.4.0", "1.4.0", "a" * 64)


class ReleaseCommandTests(unittest.TestCase):
    def test_prepare_and_consume_request_in_real_repository(self):
        script = Path(__file__).with_name("release-policy.py").resolve()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "--quiet", directory], check=True)
            config_dir = root / ".github/release-please"
            config_dir.mkdir(parents=True)
            config_path = config_dir / "release-please-config.json"
            manifest_path = config_dir / ".release-please-manifest.json"
            config_path.write_text(
                json.dumps(
                    {"packages": {"platform": {"draft": True, "prerelease": False}}}
                )
            )
            manifest_path.write_text(json.dumps({"platform": "1.3.49"}))

            def git(*args):
                return subprocess.check_output(
                    [
                        "git",
                        "-c",
                        "user.name=Release Test",
                        "-c",
                        "user.email=release@example.com",
                        "-c",
                        "core.hooksPath=/dev/null",
                        *args,
                    ],
                    cwd=root,
                    text=True,
                ).strip()

            git("add", ".")
            git("commit", "--quiet", "-m", "initial state")
            anchor = git("rev-parse", "HEAD")
            # Previous stable tag on a sibling branch, not in the new branch's ancestry.
            git("checkout", "--quiet", "-b", "old-release")
            git("commit", "--quiet", "--allow-empty", "-m", "previous stable release")
            git("tag", "platform-v1.3.49")
            git("checkout", "--quiet", "-b", "next-release", anchor)
            result = subprocess.run(
                [
                    "python3",
                    str(script),
                    "prepare",
                    "1.4.0-rc.1",
                    "--branch",
                    "release/1.4",
                ],
                cwd=root,
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("Prepared 1.4.0-rc.1", result.stdout)
            self.assertEqual(
                json.loads(config_path.read_text())["last-release-sha"], anchor
            )
            self.assertTrue(
                json.loads(config_path.read_text())["packages"]["platform"][
                    "prerelease"
                ]
            )
            self.assertEqual(
                json.loads(manifest_path.read_text())["platform"], "1.3.49"
            )
            command = [
                "python3",
                str(script),
                "check",
                "--branch",
                "release/1.4",
                "--latest",
                "1.3.49",
            ]
            self.assertIn(
                "create_pr=true", subprocess.check_output(command, cwd=root, text=True)
            )
            manifest_path.write_text(json.dumps({"platform": "1.4.0-rc.1"}))
            self.assertIn(
                "create_pr=false", subprocess.check_output(command, cwd=root, text=True)
            )
            git("add", ".")
            git("commit", "--quiet", "-m", "release candidate")
            candidate_sha = git("rev-parse", "HEAD")
            git("tag", "platform-v1.4.0-rc.1")
            subprocess.run(
                ["python3", str(script), "prepare", "1.4.0", "--branch", "release/1.4"],
                cwd=root,
                check=True,
                capture_output=True,
            )
            self.assertFalse(
                json.loads(config_path.read_text())["packages"]["platform"][
                    "prerelease"
                ]
            )
            self.assertEqual(
                json.loads(config_path.read_text())["last-release-sha"], candidate_sha
            )


if __name__ == "__main__":
    unittest.main()
