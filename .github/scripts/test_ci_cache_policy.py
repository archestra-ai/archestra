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
    def test_dockerhub_has_no_cache_reads_or_writes(self):
        workflow = (ROOT / ".github/workflows/build-native-multi-arch-image.yml").read_text()
        step = workflow.split("      - name: Resolve build cache refs\n", 1)[1].split("      - name:", 1)[0]
        env_block, run_block = step.split("        run: |\n", 1)
        expression = re.search(r"USE_REGISTRY_CACHE: \$\{\{ (.*) \}\}", env_block).group(1)
        script = "\n".join(line[10:] for line in run_block.splitlines())
        for provider in ("dockerhub", "ghcr", "gar", "none"):
            for export in ("true", "false"):
                with self.subTest(provider=provider, export=export), tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "outputs"
                    enabled = evaluate(expression, {"inputs": {"auth_provider": provider}})
                    subprocess.run(["bash", "-e", "-c", script], check=True, env=os.environ | {
                        "GITHUB_OUTPUT": str(output), "USE_REGISTRY_CACHE": str(enabled).lower(),
                        "CAN_EXPORT_CACHE": export,
                        "CACHE_REF": "registry.test/platform:buildcache-amd64",
                    })
                    values = dict(line.split("=", 1) for line in output.read_text().splitlines())
                    self.assertEqual(bool(values["cache-from"]), provider != "dockerhub")
                    self.assertEqual(bool(values["cache-to"]), provider != "dockerhub" and export == "true")


if __name__ == "__main__":
    unittest.main()
