"""Exercise queue job input classification and release tag selection."""

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


inputs = load("queue-job-inputs")
tags = load("release-upgrade-tags")
ALL = {"backend": True, "frontend": True, "platform_rust": True, "ai_labs": True}


def runs(*paths):
    return {name for name, run in inputs.classify(list(paths)).items() if run}


class ClassificationTests(unittest.TestCase):
    def test_empty_diff_runs_everything(self):
        self.assertEqual(inputs.classify([]), ALL)

    def test_backend_only_change_skips_frontend_and_rust(self):
        self.assertEqual(runs("platform/backend/src/routes/agent.ts"), {"backend"})

    def test_frontend_only_change_skips_backend_and_rust(self):
        self.assertEqual(runs("platform/frontend/src/app/page.tsx"), {"frontend"})

    def test_shared_and_lockfile_reach_both_suites(self):
        for path in ("platform/shared/index.ts", "platform/pnpm-lock.yaml", "platform/package.json"):
            with self.subTest(path=path):
                self.assertEqual(runs(path), {"backend", "frontend"})

    def test_generated_openapi_runs_both_suites(self):
        self.assertEqual(runs("docs/openapi.json"), {"backend", "frontend"})

    def test_docs_catalog_and_prose_skip_everything(self):
        self.assertEqual(runs("docs/pages/setup.md", "mcp-catalog/github.json",
                              ".agents/skills/foo/SKILL.md", "README.md"), set())

    def test_e2e_fixtures_reach_backend_but_specs_do_not(self):
        self.assertEqual(runs("platform/e2e-tests/fixtures/agents.ts"), {"backend"})
        self.assertEqual(runs("platform/e2e-tests/tests/chat.spec.ts"), set())

    def test_rust_inputs(self):
        self.assertEqual(runs("platform/archestra-rs/sandbox-core/src/lib.rs"), {"backend", "platform_rust"})
        self.assertEqual(runs("platform/rust-toolchain.toml"), {"backend", "frontend", "platform_rust"})
        self.assertEqual(runs("ai-labs/runner/src/main.rs"), {"ai_labs"})
        self.assertEqual(runs(".agents/skills/archestra-dev-bench-analysis/bin/render-triage.mjs"), {"ai_labs"})

    def test_shared_ci_plumbing_runs_every_family(self):
        for path in (".github/workflows/on-pull-requests.yml", ".github/actions/setup-env/action.yml",
                     ".github/scripts/queue-job-inputs.py"):
            with self.subTest(path=path):
                self.assertEqual(inputs.classify([path]), ALL)

    def test_unknown_paths_run_the_skip_list_suites(self):
        self.assertEqual(runs("platform/new-package/index.ts"), {"backend", "frontend"})
        self.assertEqual(runs(".github/workflows/some-new-workflow.yml"), {"backend", "frontend"})

    def test_cli_handles_renames_deletions_and_invalid_base(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=directory, stderr=subprocess.DEVNULL).decode().strip()
            git("init", "-q")
            git("config", "user.name", "CI test")
            git("config", "user.email", "test@example.invalid")
            root = Path(directory)
            (root / "platform/archestra-rs").mkdir(parents=True)
            (root / "platform/archestra-rs/lib.rs").write_text("fn main() {}")
            git("add", ".")
            git("commit", "-qm", "base")
            base = git("rev-parse", "HEAD")
            (root / "docs").mkdir()
            (root / "platform/archestra-rs/lib.rs").rename(root / "docs/moved.rs")
            git("add", "-A")
            git("commit", "-qm", "move")
            script = ROOT / ".github/scripts/queue-job-inputs.py"
            result = subprocess.run(["python3", str(script), base, "HEAD"], cwd=directory,
                                    capture_output=True, text=True, check=True)
            self.assertEqual(result.stdout.splitlines(), [
                "backend=true", "frontend=false", "platform_rust=true", "ai_labs=false",
            ])
            result = subprocess.run(["python3", str(script), "missing", "HEAD"], cwd=directory, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


class ReleaseTagTests(unittest.TestCase):
    def test_newest_stable_tag_per_fetched_line(self):
        remote = ["platform-v1.3.9", "platform-v1.3.10", "platform-v1.4.2", "platform-v1.4.3-rc.1",
                  "platform-v1.5.0-rc.20", "platform-v1.40.1", "platform-v1.2.48"]
        self.assertEqual(tags.latest_stable_tags(remote, {"1.3", "1.4", "1.5"}),
                         ["platform-v1.3.10", "platform-v1.4.2"])
        self.assertEqual(tags.latest_stable_tags(remote, set()), [])

    def test_parses_ls_remote_output(self):
        output = ["abc\trefs/tags/platform-v1.4.2\n", "def\trefs/heads/main\n", ""]
        self.assertEqual(tags.parse_ls_remote(output), ["platform-v1.4.2"])

    def test_fetch_script_fetches_only_selected_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args, cwd):
                return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.DEVNULL).decode().strip()
            upstream, clone = Path(directory, "upstream"), Path(directory, "clone")
            upstream.mkdir()
            clone.mkdir()
            git("init", "-q", "-b", "main", cwd=upstream)
            git("config", "user.name", "CI test", cwd=upstream)
            git("config", "user.email", "test@example.invalid", cwd=upstream)
            for tag in ("platform-v1.3.9", "platform-v1.3.10", "platform-v1.4.0", "platform-v1.4.1-rc.1"):
                git("commit", "-q", "--allow-empty", "-m", tag, cwd=upstream)
                git("tag", tag, cwd=upstream)
            git("branch", "release/1.3", cwd=upstream)
            git("branch", "release/1.4", cwd=upstream)
            git("init", "-q", cwd=clone)
            git("fetch", "-q", "--no-tags", "--depth=1", str(upstream),
                "+refs/heads/release/*:refs/remotes/origin/release/*", cwd=clone)
            subprocess.run(
                ["bash", str(ROOT / ".github/scripts/fetch-release-upgrade-tags.sh"), str(upstream)],
                cwd=clone, check=True, capture_output=True, env=os.environ | {"GH_TOKEN": ""},
            )
            self.assertEqual(git("tag", "--list", cwd=clone).split(), ["platform-v1.3.10", "platform-v1.4.0"])


if __name__ == "__main__":
    unittest.main()
