"""Exercise cache publication and cold-cache compilation decisions from CI."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def evaluate(expression, context):
    # These workflow predicates use the JS-compatible boolean/comparison
    # subset of Actions expressions, plus its format function.
    expression = re.sub(r"\.([A-Za-z_][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)", r"['\1']", expression)
    result = subprocess.run(
        ["node", "-e", """
const vm = require('node:vm');
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
input.context.format = (template, value) => template.replace('{0}', value);
process.stdout.write(JSON.stringify(vm.runInNewContext(input.expression, input.context)));
"""],
        input=json.dumps({"expression": expression, "context": context}),
        text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


class CachePolicyTests(unittest.TestCase):
    def test_only_trusted_default_branch_publishers_can_save_rust_caches(self):
        action = (ROOT / ".github/actions/setup-rust-build/action.yml").read_text()
        expression = re.search(r"^        save-if: \$\{\{ (.*) \}\}$", action, re.M).group(1)
        for event in ("push", "schedule", "workflow_dispatch", "merge_group",
                      "pull_request", "pull_request_target", "workflow_run"):
            for ref in ("refs/heads/main", "refs/heads/feature", "refs/pull/1/merge",
                        "refs/heads/gh-readonly-queue/main/pr-1", "refs/tags/v1"):
                for enabled in ("true", "false"):
                    with self.subTest(event=event, ref=ref, enabled=enabled):
                        allowed = evaluate(expression, {
                            "inputs": {"save-if": enabled},
                            "github": {
                                "ref": ref, "event_name": event,
                                "event": {"repository": {"default_branch": "main"}},
                            },
                        })
                        self.assertEqual(allowed, enabled == "true" and
                                         ref == "refs/heads/main" and
                                         event in ("push", "schedule", "workflow_dispatch"))
        self.assertTrue(evaluate(expression, {
            "inputs": {"save-if": "true"},
            "github": {"ref": "refs/heads/trunk", "event_name": "push",
                       "event": {"repository": {"default_branch": "trunk"}}},
        }))

    def compile_dependencies(self, hit, fail=False):
        source = (ROOT / ".github/workflows/warm-rust-check-caches.yml").read_text()
        section = source.split("      - name: Warm check and test dependencies\n", 1)[1]
        section = section.split("      - name:", 1)[0]
        condition = re.search(r"^        if: (.*)$", section, re.M).group(1)
        # A dot in an Actions step id denotes property access; these ids have
        # hyphens, which the expression language also permits in identifiers.
        condition = condition.replace("steps.cargo-cache", "steps['cargo-cache']")
        if not evaluate(condition, {"steps": {"cargo-cache": {"outputs": {"cache-hit": hit}}}}):
            return None, []
        script = "\n".join(line[10:] for line in section.split("        run: |\n", 1)[1].splitlines())
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            calls = directory / "calls"
            cargo = directory / "cargo"
            cargo.write_text(
                '#!/bin/bash\nprintf "%s\\n" "$*" >> "$ARCHESTRA_TEST_CARGO_CALLS"\n'
                'if [ "$ARCHESTRA_TEST_CARGO_FAIL" = true ]; then exit 23; fi\n'
            )
            cargo.chmod(0o755)
            result = subprocess.run(
                ["bash", "-eo", "pipefail", "-c", script],
                env=os.environ | {
                    "PATH": f"{directory}:{os.environ['PATH']}",
                    "ARCHESTRA_TEST_CARGO_CALLS": str(calls),
                    "ARCHESTRA_TEST_CARGO_FAIL": str(fail).lower(),
                },
                capture_output=True, text=True,
            )
            return result.returncode, calls.read_text().splitlines() if calls.exists() else []

    def test_exact_hit_does_not_allocate_compilation_work(self):
        self.assertEqual(self.compile_dependencies("true"), (None, []))

    def test_misses_compile_dependencies_without_executing_test_suites(self):
        for hit in ("false", ""):
            with self.subTest(hit=hit):
                status, calls = self.compile_dependencies(hit)
                self.assertEqual(status, 0)
                self.assertEqual(calls, [
                    "check --workspace --all-targets --locked",
                    "test --workspace --locked --no-run",
                ])

    def test_failed_check_does_not_continue_warming(self):
        status, calls = self.compile_dependencies("false", fail=True)
        self.assertNotEqual(status, 0)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
