"""Run the workflow's check scripts to verify cheap failures stop later work."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


WORKFLOW = Path(__file__).resolve().parents[1] / "workflows/on-pull-requests.yml"


def check_scripts(job, pattern):
    source = WORKFLOW.read_text().split(f"  {job}:\n", 1)[1]
    source = re.split(r"^  [\w-]+:\s*$", source, maxsplit=1, flags=re.M)[0]
    scripts = []
    for step in re.split(r"^      - ", source, flags=re.M)[1:]:
        match = re.search(r"^        run: (.+)$", step, re.M)
        if not match:
            continue
        script = match.group(1)
        if script == "|":
            script = textwrap.dedent("\n".join(
                line for line in step[match.end():].splitlines()
                if line.startswith("          ") or not line.strip()
            ))
        if re.search(pattern, script):
            scripts.append(script)
    return scripts


class CheckOrderTests(unittest.TestCase):
    def run_scripts(self, scripts, fail):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            calls = directory / "calls"
            for command in ("pnpm", "cargo"):
                executable = directory / command
                executable.write_text(
                    "#!/usr/bin/env python3\n"
                    "import json, os, pathlib, sys\n"
                    "args = [pathlib.Path(sys.argv[0]).name, *sys.argv[1:]]\n"
                    "with open(os.environ['ARCHESTRA_TEST_CHECK_CALLS'], 'a') as out:\n"
                    "    out.write(json.dumps(args) + '\\n')\n"
                    "if ' '.join(args) == os.environ['ARCHESTRA_TEST_CHECK_FAIL']:\n"
                    "    sys.exit(23)\n"
                )
                executable.chmod(0o755)
            env = os.environ | {
                "PATH": f"{directory}:{os.environ['PATH']}",
                "ARCHESTRA_TEST_CHECK_CALLS": str(calls),
                "ARCHESTRA_TEST_CHECK_FAIL": fail,
            }
            status = 0
            for script in scripts:
                result = subprocess.run(
                    ["bash", "-eo", "pipefail", "-c", script],
                    env=env, cwd=directory, text=True, capture_output=True,
                )
                status = result.returncode
                if status:
                    break
            return status, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_backend_static_failure_does_not_start_frontend_tests(self):
        scripts = check_scripts(
            "platform-lint-and-unit-tests", r"pnpm (exec turbo check:|check:white-label)",
        )
        status, calls = self.run_scripts(scripts, "pnpm exec turbo check:commit --filter=@backend")
        self.assertNotEqual(status, 0)
        self.assertEqual(calls, [["pnpm", "exec", "turbo", "check:commit", "--filter=@backend"]])

    def test_white_label_failure_does_not_start_frontend_tests(self):
        scripts = check_scripts(
            "platform-lint-and-unit-tests", r"pnpm (exec turbo check:|check:white-label)",
        )
        status, calls = self.run_scripts(scripts, "pnpm check:white-label")
        self.assertNotEqual(status, 0)
        self.assertEqual(calls[-1], ["pnpm", "check:white-label"])
        self.assertFalse(any("check:ci" in call for call in calls))

    def test_advisory_failure_does_not_compile_or_test_rust(self):
        scripts = check_scripts("platform-rust-checks", r"cargo (deny|fmt)")
        status, calls = self.run_scripts(scripts, "cargo deny --config deny.toml check advisories bans licenses sources")
        self.assertNotEqual(status, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ["cargo", "deny"])

    def test_compile_failure_still_stops_before_rust_tests(self):
        scripts = check_scripts("platform-rust-checks", r"cargo (deny|fmt)")
        status, calls = self.run_scripts(scripts, "cargo check --workspace --locked")
        self.assertNotEqual(status, 0)
        self.assertFalse(any(call[:2] == ["cargo", "test"] for call in calls))
        self.assertEqual(calls[0][:2], ["cargo", "deny"])


if __name__ == "__main__":
    unittest.main()
