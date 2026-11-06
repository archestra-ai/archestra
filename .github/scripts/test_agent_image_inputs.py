"""Exercise which agent catalog images a diff selects for validation."""

import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).with_name("agent-image-inputs.py")

spec = importlib.util.spec_from_file_location("agent_image_inputs", SCRIPT)
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)

DOCKERFILE = (ROOT / inputs.DOCKERFILE).read_text()
AGENT = inputs.AGENT_DIR


def selected(*paths, before=DOCKERFILE, after=DOCKERFILE):
    return inputs.classify(list(paths), lambda: (before, after))


def edit_stage(stage, text=DOCKERFILE):
    """The Dockerfile with one line added to the end of a stage."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if re.search(rf"\sAS\s+{stage}\s*$", line))
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("FROM ")), len(lines))
    return "\n".join(lines[:end] + ["RUN true"] + lines[end:])


class ClassificationTests(unittest.TestCase):
    def test_empty_diff_builds_every_image(self):
        self.assertEqual(inputs.classify([], lambda: ("", "")), inputs.ALL)

    def test_paths_outside_the_images_build_nothing(self):
        self.assertEqual(selected("platform/frontend/src/app/page.tsx", "docs/pages/index.md"), [])

    def test_prose_builds_nothing(self):
        self.assertEqual(selected(AGENT + "README.md", AGENT + "runtime-contract.md"), [])

    def test_an_agents_own_files_build_only_its_image(self):
        cases = {
            AGENT + "bin/archestra-opencode": ["agent-opencode"],
            AGENT + "bin/archestra-kimi-hook": ["agent-kimi"],
            AGENT + "bin/archestra-claude-tui-start": ["agent-claude-code"],
            AGENT + "bin/archestra-codex-failure-watch": ["agent-codex"],
            AGENT + "tests/copilot.py": ["agent-copilot"],
            AGENT + "tests/hermes-startup.py": ["agent-hermes"],
            AGENT + "patches/openclaw-mcp-required.py": ["agent-openclaw"],
            AGENT + "openclaw/pnpm-lock.yaml": ["agent-openclaw"],
        }
        for path, targets in cases.items():
            with self.subTest(path=path):
                self.assertEqual(selected(path), targets)

    def test_shared_files_build_every_image(self):
        for path in (
            AGENT + "bin/archestra-tui-exec",
            AGENT + "bin/gh",
            AGENT + "tests/command-oom-score.py",
            AGENT + "tests/mcp-startup.py",
            AGENT + "requirements.lock",
            AGENT + "environment.md",
            AGENT + "something-new",
            "platform/backend/src/static/workspace-files.py",
            "platform/.dockerignore",
            ".github/workflows/build-agent-catalog-images.yml",
            ".github/actions/build-docker-image/action.yml",
        ):
            with self.subTest(path=path):
                self.assertEqual(selected(path), inputs.ALL)

    def test_a_target_stage_edit_builds_only_that_image(self):
        for target in inputs.TARGETS:
            with self.subTest(target=target):
                self.assertEqual(selected(inputs.DOCKERFILE, after=edit_stage(target)), [target])

    def test_a_builder_stage_only_hermes_uses_builds_hermes(self):
        self.assertEqual(selected(inputs.DOCKERFILE, after=edit_stage("uv-hermes")), ["agent-hermes"])

    def test_a_shared_stage_edit_builds_every_image(self):
        for stage in ("agent-base", "rust", "gh-build"):
            with self.subTest(stage=stage):
                self.assertEqual(selected(inputs.DOCKERFILE, after=edit_stage(stage)), inputs.ALL)

    def test_changes_combine(self):
        self.assertEqual(
            selected(AGENT + "bin/archestra-grok", AGENT + "tests/codex-failure.py"),
            ["agent-codex", "agent-grok"],
        )


class AlignmentTests(unittest.TestCase):
    def test_targets_are_the_dockerfiles_agent_stages(self):
        stages = set(re.findall(r"^FROM agent-base AS (\S+)$", DOCKERFILE, re.MULTILINE))
        self.assertEqual(stages, set(inputs.TARGETS))

    def test_targets_are_the_workflows_publish_matrix(self):
        workflow = (ROOT / ".github/workflows/build-agent-catalog-images.yml").read_text()
        listed = set(re.findall(r"^\s+- (agent-[a-z-]+)$", workflow, re.MULTILINE))
        self.assertEqual(listed, set(inputs.TARGETS))


class CommandLineTests(unittest.TestCase):
    def test_prints_the_targets_a_commit_range_selects(self):
        with tempfile.TemporaryDirectory() as repo:
            git = lambda *args: subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
            git("init", "-q")
            path = Path(repo, AGENT, "bin")
            path.mkdir(parents=True)
            (path / "archestra-kimi").write_text("one\n")
            git("add", ".")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base")
            (path / "archestra-kimi").write_text("two\n")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "head")
            out = subprocess.check_output([sys.executable, SCRIPT, "HEAD~1", "HEAD"], cwd=repo)
            self.assertEqual(json.loads(out), ["agent-kimi"])

    def test_a_failed_diff_exits_nonzero(self):
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            result = subprocess.run([sys.executable, SCRIPT, "nope", "HEAD"], cwd=repo, capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
