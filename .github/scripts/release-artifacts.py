#!/usr/bin/env python3
"""Record release artifact identities; verify them before moving stable aliases."""

import argparse
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

COMPANION_IMAGES = (
    "mcp-server-base",
    "p4-shim",
    "sandbox-base",
    "agent-archestra",
    "agent-claude-code",
    "agent-codex",
    "agent-opencode",
    "agent-hermes",
    "agent-openclaw",
)


def image_names(registry):
    if not re.fullmatch(r"[a-z0-9.-]+/[a-zA-Z0-9_./-]+", registry):
        raise ValueError(
            "Set RELEASE_AUX_IMAGE_REGISTRY to the existing companion image registry prefix"
        )
    return [f"{registry}/{name}" for name in COMPANION_IMAGES] + [
        "docker.io/archestra/platform"
    ]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def image_digest(reference):
    manifest = json.loads(
        subprocess.check_output(
            [
                "docker",
                "buildx",
                "imagetools",
                "inspect",
                reference,
                "--format",
                "{{json .Manifest}}",
            ],
            text=True,
        )
    )
    digest = manifest["digest"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("Registry returned an invalid digest")
    return digest


def validate_manifest(*, manifest, requested, registry, commit, run_id, chart):
    if (
        manifest["version"] != requested
        or manifest["commit"] != commit
        or manifest["build_run_id"] != run_id
    ):
        raise ValueError(
            "Artifact manifest does not match the qualified version, commit, and build run"
        )
    if set(manifest["images"]) != set(image_names(registry)):
        raise ValueError(
            "Artifact manifest must include exactly the platform and all companion images"
        )
    if any(
        not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
        for digest in manifest["images"].values()
    ):
        raise ValueError("Artifact manifest contains an invalid image digest")
    if manifest["chart_sha256"] != sha256(chart):
        raise ValueError("Chart differs from the qualified archive")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("record", "check", "publish"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", type=Path, default=Path("release-artifacts.json"))
    parser.add_argument("--manifest-sha256")
    parser.add_argument("--commit", default=os.environ.get("GITHUB_SHA"))
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID"))
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.[1-9]\d*)?", args.version):
        raise ValueError("Invalid release version")
    registry = os.environ.get("AUX_IMAGE_REGISTRY", "")
    names = image_names(registry)
    chart = Path(f"archestra-platform-{args.version}.tgz")
    if args.command == "record":
        manifest = {
            "version": args.version,
            "commit": args.commit,
            "build_run_id": args.run_id,
            "chart_sha256": sha256(chart),
            "images": {name: image_digest(f"{name}:{args.version}") for name in names},
        }
        args.output.write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"Qualification manifest SHA-256: {sha256(args.output)}")
        return
    if args.manifest_sha256 != sha256(args.output):
        raise ValueError("Manifest differs from the one used during qualification")
    manifest = json.loads(args.output.read_text())
    validate_manifest(
        manifest=manifest,
        requested=args.version,
        registry=registry,
        commit=args.commit,
        run_id=args.run_id,
        chart=chart,
    )
    # Validate the whole set before making any externally visible changes.
    for name in names:
        if image_digest(f"{name}:{args.version}") != manifest["images"][name]:
            raise ValueError(f"Image changed after qualification: {name}")
    if args.command == "publish":
        if "-" in args.version:
            raise ValueError("Only stable versions may update stable aliases")
        subprocess.run(
            ["helm", "push", str(chart), f"oci://{registry}/helm-charts"], check=True
        )
        for name in names:
            # supply-chain-policy: allow-latest stable release channel publication
            subprocess.run(
                [
                    "docker",
                    "buildx",
                    "imagetools",
                    "create",
                    "--tag",
                    f"{name}:latest",
                    f"{name}@{manifest['images'][name]}",
                ],
                check=True,
            )


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from error
