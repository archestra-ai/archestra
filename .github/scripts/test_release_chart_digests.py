"""Pin the real chart's values to release image digests."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "release-chart-digests.py"
VALUES = Path(__file__).resolve().parents[2] / "platform/helm/archestra/values.yaml"
DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64


class ReleaseChartDigestTests(unittest.TestCase):
    def pin(self, *, version="1.6.0", digests=None, values=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "values.yaml"
            path.write_text(VALUES.read_text() if values is None else values)
            env = {
                **os.environ,
                "VERSION": version,
                "DIGESTS": json.dumps(
                    {"mcp-server-base": DIGEST_A, "agent-codex": DIGEST_B} if digests is None else digests
                ),
            }
            result = subprocess.run(
                [sys.executable, "-I", str(SCRIPT), str(path)], env=env, capture_output=True, text=True
            )
            return result, path.read_text()

    def test_pins_the_chart_to_the_released_digests(self):
        result, values = self.pin()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = [line for line in values.splitlines() if line.startswith("  releaseImageDigests:")]
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0].split(":", 1)[1]), {
            "version": "1.6.0",
            "images": {"agent-codex": DIGEST_B, "mcp-server-base": DIGEST_A},
        })
        # Nothing else in the shipped values changes.
        self.assertEqual(
            values.replace(lines[0] + "\n", ""),
            VALUES.read_text().replace("  releaseImageDigests: {}\n", ""),
        )

    def test_rejects_bad_input_and_leaves_the_chart_unchanged(self):
        for kwargs in (
            {"version": "latest"},
            {"digests": {"agent-codex": DIGEST_B}},
            {"digests": {"mcp-server-base": "sha256:short"}},
            {"digests": {"mcp-server-base": DIGEST_A, "../x": DIGEST_B}},
            {"values": "archestra:\n  imageTag: x\n"},
        ):
            with self.subTest(**{key: str(value) for key, value in kwargs.items()}):
                result, values = self.pin(**kwargs)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Cannot pin release image digests", result.stderr)
                if "values" not in kwargs:
                    self.assertEqual(values, VALUES.read_text())


if __name__ == "__main__":
    unittest.main()
