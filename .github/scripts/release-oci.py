#!/usr/bin/env python3
"""Verify the runtime image and original BuildKit provenance in an OCI archive."""

import hashlib
import json
import re
import tarfile

DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def validate_metadata(proof, image_id):
    if (not isinstance(proof, dict) or proof.get("config") != image_id
            or not DIGEST.fullmatch(proof.get("runtime_manifest", ""))):
        raise ValueError("Missing OCI runtime identity")
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
        walk(read("index.json"))
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
                 "attestations": sorted(attestations), "provenance": sorted(provenance)}
        validate_metadata(proof, image_id)
        return proof
