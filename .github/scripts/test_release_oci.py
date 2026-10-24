"""Deterministic OCI runtime/provenance fixtures; no registry or image execution."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("oci", Path(__file__).with_name("release-oci.py"))
OCI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OCI)


def fixture_archive(arch="amd64", *, subject=None, provenance=True):
    blobs = {}
    def blob(value):
        data = json.dumps(value, separators=(",", ":")).encode()
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        blobs["blobs/sha256/" + digest[7:]] = data
        return digest
    config = blob({"os": "linux", "architecture": arch, "rootfs": {"type": "layers", "diff_ids": []}})
    runtime = blob({"schemaVersion": 2, "config": {"digest": config}, "layers": []})
    manifests = [{"digest": runtime, "platform": {"os": "linux", "architecture": arch}}]
    attestations, statements = [], []
    if provenance:
        statement = blob({"predicateType": "https://slsa.dev/provenance/v0.2", "subject": [
            {"name": "fixture", "digest": {"sha256": (subject or runtime)[7:]}}]})
        attestation = blob({"schemaVersion": 2, "layers": [
            {"mediaType": "application/vnd.in-toto+json", "digest": statement}]})
        manifests.append({"digest": attestation, "annotations": {"vnd.docker.reference.type": "attestation-manifest",
                                                                  "vnd.docker.reference.digest": runtime}})
        attestations.append(attestation)
        statements.append(statement)
    root = blob({"schemaVersion": 2, "manifests": manifests})
    blobs["index.json"] = json.dumps({"schemaVersion": 2, "manifests": [{"digest": root}]}).encode()
    blobs["oci-layout"] = b'{"imageLayoutVersion":"1.0.0"}'
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, data in blobs.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return output.getvalue(), {"config": config, "runtime_manifest": runtime,
                              "attestations": attestations, "provenance": statements}


class OciTests(unittest.TestCase):
    def inspect(self, payload, proof, arch="amd64"):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "image.oci.tar"
            path.write_bytes(payload)
            return OCI.inspect(path, proof["config"], arch)

    def test_both_architectures_keep_runtime_and_original_provenance(self):
        for arch in ("amd64", "arm64"):
            payload, proof = fixture_archive(arch)
            self.assertEqual(self.inspect(payload, proof, arch), proof)

    def test_missing_wrong_subject_and_wrong_architecture_provenance_fail(self):
        for options in ({"provenance": False}, {"subject": "sha256:" + "f" * 64}):
            payload, proof = fixture_archive(**options)
            with self.assertRaises(ValueError):
                self.inspect(payload, proof)
        payload, proof = fixture_archive("arm64")
        with self.assertRaises(ValueError):
            self.inspect(payload, proof, "amd64")

    def test_modified_blob_is_rejected_before_promotion(self):
        payload, proof = fixture_archive()
        altered = payload.replace(b'"linux"', b'"linuz"', 1)
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.inspect(altered, proof)


if __name__ == "__main__":
    unittest.main()
