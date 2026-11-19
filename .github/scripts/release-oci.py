#!/usr/bin/env python3
"""Verify the runtime image and original BuildKit provenance in an OCI archive,
and write the multi-arch index a release pushes for two of them.

The merge queue writes that index from the scanned archives and signs its
provenance; the release pushes the same bytes, so the published digest is the
one the queue built (multi_arch_index)."""

import hashlib
import json
import re
import tarfile

DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def multi_arch_index(proofs):
    """The OCI index of both architectures' images: each archive's root index
    entries (runtime manifest and its attestation manifest), amd64 first, as
    compact JSON with sorted keys, so every writer makes the same bytes."""
    if set(proofs) != set(ARCHES):
        raise ValueError("A release image needs exactly amd64 and arm64")
    manifests = []
    for arch in ARCHES:
        proof = proofs[arch]
        validate_descriptors(proof)
        manifests.extend(proof["descriptors"])
    index = {"schemaVersion": 2, "mediaType": INDEX_MEDIA_TYPE, "manifests": manifests}
    return json.dumps(index, separators=(",", ":"), sort_keys=True).encode()


def validate_metadata(proof, image_id):
    if (not isinstance(proof, dict) or proof.get("config") != image_id
            or not DIGEST.fullmatch(proof.get("runtime_manifest", ""))):
        raise ValueError("Missing OCI runtime identity")
    validate_descriptors(proof)
    for key in ("attestations", "provenance"):
        values = proof.get(key)
        if (not isinstance(values, list) or not values or len(values) != len(set(values))
                or not all(isinstance(value, str) and DIGEST.fullmatch(value) for value in values)):
            raise ValueError("Missing or invalid original OCI provenance")


def inspect(archive, image_id, arch):
    with tarfile.open(archive, "r:*") as files:
        members = {}
        for member in files:
            name = member.name.removeprefix("./")
            if member.isdir():
                continue
            if not member.isfile() or name in members or ".." in name.split("/"):
                raise ValueError("Unexpected OCI archive member")
            members[name] = member
            if name.startswith("blobs/sha256/"):
                expected = name.removeprefix("blobs/sha256/")
                if not re.fullmatch(r"[0-9a-f]{64}", expected):
                    raise ValueError("Invalid OCI blob name")
                with files.extractfile(member) as source:
                    if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                        raise ValueError("OCI blob checksum mismatch")

        def read(name):
            member = members[name]
            if member.size > 1024**2:
                raise ValueError("Oversized OCI JSON metadata")
            with files.extractfile(member) as source:
                return json.load(source)

        def blob(reference):
            if not DIGEST.fullmatch(reference):
                raise ValueError("Invalid OCI descriptor")
            return read("blobs/sha256/" + reference.removeprefix("sha256:"))

        runtime, attestations, provenance = [], [], []
        pending = []

        def walk(index, depth=0):
            if depth > 8:
                raise ValueError("Nested OCI index exceeds limit")
            for descriptor in index["manifests"]:
                value = blob(descriptor["digest"])
                if "manifests" in value:
                    walk(value, depth + 1)
                elif descriptor.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
                    pending.append((descriptor, value))
                else:
                    config = blob(value["config"]["digest"])
                    if (value["config"]["digest"] != image_id or config["os"] != "linux"
                            or config["architecture"] != arch):
                        raise ValueError("OCI runtime differs from the locally scanned image")
                    runtime.append(descriptor["digest"])

        if read("oci-layout")["imageLayoutVersion"] != "1.0.0":
            raise ValueError("Unsupported OCI layout")
        layout = read("index.json")
        if len(layout.get("manifests", [])) != 1:
            raise ValueError("An OCI archive must hold exactly one root index")
        root = blob(layout["manifests"][0]["digest"])
        if not isinstance(root.get("manifests"), list):
            raise ValueError("The OCI archive's root is not an index")
        walk(layout)
        if len(runtime) != 1 or not pending:
            raise ValueError("Exactly one runtime and original provenance are required")
        for descriptor, manifest in pending:
            if descriptor["annotations"].get("vnd.docker.reference.digest") != runtime[0]:
                raise ValueError("OCI attestation is bound to another runtime")
            attestations.append(descriptor["digest"])
            for layer in manifest["layers"]:
                if layer.get("mediaType") != "application/vnd.in-toto+json":
                    continue
                statement = blob(layer["digest"])
                if statement.get("predicateType") in ("https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"):
                    if not any(subject.get("digest", {}).get("sha256") == runtime[0].removeprefix("sha256:")
                               for subject in statement.get("subject", [])):
                        raise ValueError("Provenance subject differs from the scanned runtime")
                    provenance.append(layer["digest"])
        proof = {"config": image_id, "runtime_manifest": runtime[0],
                 "attestations": sorted(attestations), "provenance": sorted(provenance),
                 "root": layout["manifests"][0]["digest"], "descriptors": root["manifests"]}
        validate_metadata(proof, image_id)
        return proof


def validate_descriptors(proof):
    """The archive's root index entries: its runtime manifest and attestation
    manifests, each a descriptor of one digest."""
    descriptors = proof.get("descriptors") if isinstance(proof, dict) else None
    if (not DIGEST.fullmatch(str(proof.get("root", "") if isinstance(proof, dict) else ""))
            or not isinstance(descriptors, list) or not descriptors
            or not all(isinstance(entry, dict) and DIGEST.fullmatch(str(entry.get("digest", "")))
                       for entry in descriptors)):
        raise ValueError("Missing OCI root index entries")
    digests = [entry["digest"] for entry in descriptors]
    if sorted(digests) != sorted([proof["runtime_manifest"], *proof.get("attestations", [])]):
        raise ValueError("The OCI root index holds other manifests than the runtime and its attestations")


ARCHES = ("amd64", "arm64")
INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json"
