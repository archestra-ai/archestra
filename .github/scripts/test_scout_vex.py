"""Which of our VEX statements a scan of one image applies, in Scout's form."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("scout-vex.py")
spec = importlib.util.spec_from_file_location("scout_vex", SCRIPT)
scout_vex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scout_vex)

GIT = "pkg:apk/alpine/git@2.52.1-r0?os_name=alpine&os_version=3.23"
CURL = "pkg:deb/debian/curl@8.14.1-2%2Bdeb13u7?arch=amd64"
DOCUMENT = {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": "https://archestra.ai/vex",
    "author": "Archestra (https://archestra.ai)",
    "statements": [
        {
            "vulnerability": {"name": "CVE-2025-66413"},
            "products": [{"@id": "pkg:oci/platform", "subcomponents": [{"@id": GIT}, {"@id": GIT}]}],
            "status": "not_affected",
            "justification": "vulnerable_code_not_present",
        },
        {
            "vulnerability": {"name": "CVE-2026-10536"},
            "products": [
                {"@id": "pkg:oci/sandbox-base", "subcomponents": [{"@id": CURL}]},
                {"@id": "pkg:oci/agent-codex", "subcomponents": [{"@id": "pkg:deb/debian/libcurl4t64@1"}]},
            ],
            "status": "not_affected",
            "justification": "vulnerable_code_not_in_execute_path",
        },
    ],
}


class ScoutVexTests(unittest.TestCase):
    def test_image_reference_names_its_product(self):
        for reference in ("registry://ghcr.io/archestra-ai/ci/sandbox-base@sha256:ab",
                          "local://local/sandbox-base:fix", "ghcr.io/archestra-ai/sandbox-base:1.5.0"):
            self.assertEqual(scout_vex.image_product(reference), "pkg:oci/sandbox-base", reference)
        self.assertEqual(scout_vex.image_product("docker.io/archestra/platform:1.5.0-slim"), "pkg:oci/platform")

    def test_keeps_only_this_images_packages_as_products(self):
        result = scout_vex.scoped(DOCUMENT, "pkg:oci/sandbox-base")
        self.assertEqual(len(result["statements"]), 1)
        statement = result["statements"][0]
        self.assertEqual(statement["vulnerability"]["name"], "CVE-2026-10536")
        self.assertEqual(statement["products"], [{"@id": CURL}])
        self.assertEqual(statement["justification"], "vulnerable_code_not_in_execute_path")
        self.assertEqual(result["author"], DOCUMENT["author"])
        self.assertEqual(scout_vex.scoped(DOCUMENT, "pkg:oci/platform")["statements"][0]["products"], [{"@id": GIT}])

    def test_writes_no_document_for_an_image_no_statement_covers(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "openvex.json"
            source.write_text(json.dumps(DOCUMENT))
            output = Path(directory) / "out"
            scout_vex.main(["--document", str(source), "--image", "ghcr.io/archestra-ai/p4-shim:1", "--output", str(output)])
            self.assertEqual(list(output.iterdir()), [])
            scout_vex.main(["--document", str(source), "--image", "ghcr.io/archestra-ai/ci/platform@sha256:1", "--output", str(output)])
            written = json.loads((output / "openvex.json").read_text())
            self.assertEqual([s["vulnerability"]["name"] for s in written["statements"]], ["CVE-2025-66413"])


if __name__ == "__main__":
    unittest.main()
