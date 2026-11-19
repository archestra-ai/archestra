"""Tests for vex.py, and the check that keeps vex/archestra.openvex.json valid."""

import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("vex", Path(__file__).with_name("vex.py"))
vex = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(vex)

DIGEST = "c" * 64
EMPTY = {
    "@context": "https://openvex.dev/ns/v0.2.0",
    "@id": "https://example.test/vex.json",
    "author": "Archestra",
    "timestamp": "2026-11-19T00:00:00Z",
    "version": 1,
    "statements": [],
}
NOT_AFFECTED = ["--status", "not_affected", "--justification", "vulnerable_code_not_in_execute_path",
                "--impact-statement", "The CLI that parses untrusted input is not shipped."]


class VexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.document = Path(self.directory.name) / "vex.json"
        self.document.write_text(json.dumps(EMPTY))

    def tearDown(self):
        self.directory.cleanup()

    def run_main(self, *argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            vex.main([*argv, "--document", str(self.document)])
        return output.getvalue()

    def statements(self):
        return json.loads(self.document.read_text())["statements"]

    def test_the_committed_document_is_valid(self):
        document = vex.load(vex.DOCUMENT)
        self.assertGreaterEqual(document["version"], 1)

    def test_a_new_status_replaces_the_old_one_for_the_images_it_names(self):
        self.run_main("set", "--vulnerability", "CVE-2026-1000", "--product", "platform", "--product", "agent-codex",
                      "--subcomponent", "pkg:npm/tar@6.2.0", "--status", "under_investigation")
        self.run_main("set", "--vulnerability", "CVE-2026-1000", "--product", "platform",
                      "--subcomponent", "pkg:npm/tar@6.2.0", *NOT_AFFECTED)
        statements = self.statements()
        by_image = {p["@id"]: s["status"] for s in statements for p in s["products"]}
        self.assertEqual(by_image, {"pkg:oci/platform": "not_affected", "pkg:oci/agent-codex": "under_investigation"})
        self.assertEqual(json.loads(self.document.read_text())["version"], 3)
        not_affected = next(s for s in statements if s["status"] == "not_affected")
        self.assertEqual(not_affected["products"][0]["subcomponents"], [{"@id": "pkg:npm/tar@6.2.0"}])
        self.assertEqual(not_affected["impact_statement"], "The CLI that parses untrusted input is not shipped.")

    def test_packages_of_one_image_keep_their_own_status_for_the_same_vulnerability(self):
        # The flaw is in libssl; libcrypto ships none of its code.
        self.run_main("set", "--vulnerability", "CVE-2026-1005", "--product", "platform",
                      "--subcomponent", "pkg:apk/alpine/libcrypto3@3.5.9-r0", "--subcomponent", "pkg:apk/alpine/libssl3@3.5.9-r0",
                      "--status", "fixed")
        self.run_main("set", "--vulnerability", "CVE-2026-1005", "--product", "platform",
                      "--subcomponent", "pkg:apk/alpine/libcrypto3@3.5.9-r0", "--status", "not_affected",
                      "--justification", "vulnerable_code_not_present", "--impact-statement", "The QUIC code is in libssl.")
        by_package = {c["@id"]: s["status"] for s in self.statements() for p in s["products"] for c in p["subcomponents"]}
        self.assertEqual(by_package, {"pkg:apk/alpine/libssl3@3.5.9-r0": "fixed",
                                      "pkg:apk/alpine/libcrypto3@3.5.9-r0": "not_affected"})
        # A statement about every package of the image replaces both.
        self.run_main("set", "--vulnerability", "CVE-2026-1005", "--product", "platform", "--status", "fixed")
        self.assertEqual([(s["status"], s["products"]) for s in self.statements()], [("fixed", [{"@id": "pkg:oci/platform"}])])

    def test_a_statement_without_its_reasons_is_refused_and_nothing_is_written(self):
        before = self.document.read_text()
        for argv in [
            ["--status", "not_affected", "--justification", "component_not_present"],  # no impact statement
            ["--status", "not_affected", "--impact-statement", "We think so."],  # no justification
            ["--status", "affected"],  # no action statement
            ["--status", "fixed", "--justification", "component_not_present"],  # justification is for not_affected
        ]:
            with self.subTest(argv=argv), self.assertRaises(vex.Invalid):
                self.run_main("set", "--vulnerability", "CVE-2026-1001", "--product", "platform", *argv)
        with self.assertRaises(vex.Invalid):
            self.run_main("set", "--vulnerability", "not-a-cve", "--product", "platform", "--status", "fixed")
        self.assertEqual(self.document.read_text(), before)

    def test_a_document_with_two_statuses_for_one_image_and_package_is_invalid(self):
        statement = {"vulnerability": {"name": "CVE-2026-1002"}, "products": [{"@id": "pkg:oci/platform"}],
                     "status": "fixed", "timestamp": "2026-11-19T00:00:00Z"}
        self.document.write_text(json.dumps({**EMPTY, "statements": [statement, {**statement, "status": "affected",
                                                                                   "action_statement": "Upgrade."}]}))
        with self.assertRaisesRegex(vex.Invalid, "keep one status"):
            self.run_main("validate")

    def test_render_pins_the_image_statements_to_its_digest(self):
        self.run_main("set", "--vulnerability", "CVE-2026-1003", "--product", "platform",
                      "--subcomponent", "pkg:golang/golang.org/x/net@v0.30.0", *NOT_AFFECTED)
        self.run_main("set", "--vulnerability", "CVE-2026-1004", "--product", "agent-codex", "--status", "fixed")
        rendered = json.loads(self.run_main("render", "--image", f"docker.io/archestra/platform:1.4.35@sha256:{DIGEST}"))
        purl = f"pkg:oci/platform@sha256%3A{DIGEST}?repository_url=docker.io/archestra/platform"
        self.assertEqual([s["vulnerability"]["name"] for s in rendered["statements"]], ["CVE-2026-1003"])
        self.assertEqual(rendered["statements"][0]["products"], [{
            "@id": purl, "identifiers": {"purl": purl}, "hashes": {"sha-256": DIGEST},
            "subcomponents": [{"@id": "pkg:golang/golang.org/x/net@v0.30.0"}],
        }])
        with self.assertRaises(vex.Invalid):
            self.run_main("render", "--image", "docker.io/archestra/platform:latest")


if __name__ == "__main__":
    unittest.main()
