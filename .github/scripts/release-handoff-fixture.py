#!/usr/bin/env python3
"""Harmless scratch-image handoff rehearsal; no scans, registry pushes or releases."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    handoff = module("release-handoff")
    directory = Path(os.environ["FIXTURE_DIR"])
    mode = sys.argv[1]
    if mode == "create":
        directory.mkdir(parents=True, exist_ok=True)
        context = directory.parent / "scratch-context"
        context.mkdir()
        (context / "Dockerfile").write_text("FROM scratch\nCOPY marker /marker\n")
        (context / "marker").write_text("non-publishing release handoff fixture\n")
        proof = {"fixture": True, "head_sha": os.environ["FIXTURE_HEAD_SHA"], "images": {}}
        for arch in ("amd64", "arm64"):
            reference = f"handoff-fixture:{os.environ['GITHUB_RUN_ID']}-{arch}"
            subprocess.run(["docker", "buildx", "build", "--network", "none", "--platform", f"linux/{arch}",
                            "--provenance", "mode=min", "--output", f"type=oci,dest={directory / (arch + '.oci.tar')},oci-artifact=false",
                            "--tag", reference, str(context)], check=True)
            subprocess.run(["skopeo", "copy", "--override-os", "linux", "--override-arch", arch,
                            "oci-archive:" + str(directory / f"{arch}.oci.tar"),
                            "docker-archive:" + str(directory / f"{arch}.scan.tar") + ":" + reference], check=True)
            subprocess.run(["docker", "load", "--input", str(directory / f"{arch}.scan.tar")], check=True)
            (directory / f"{arch}.scan.tar").unlink()
            image_id = handoff.command("docker", "image", "inspect", reference, "--format", "{{.Id}}")
            module("release-candidate").inspect_image(reference, image_id, arch)
            proof["images"][arch] = {"image_id": image_id, "oci_digest": handoff.digest(directory / f"{arch}.oci.tar"),
                                     "oci": module("release-oci").inspect(directory / f"{arch}.oci.tar", image_id, arch)}
        (directory / "fixture.json").write_text(json.dumps(proof))
    elif mode == "relay":
        repository = os.environ["GITHUB_REPOSITORY"]
        artifact = handoff.api(f"repos/{repository}/actions/artifacts/{int(os.environ['FIXTURE_ARTIFACT_ID'])}")
        run = handoff.api(f"repos/{repository}/actions/runs/{int(artifact['workflow_run']['id'])}")
        if (not artifact["name"].startswith("release-handoff-fixture-") or artifact["expired"]
                or artifact["size_in_bytes"] > 10 * 1024**2
                or run["path"] != handoff.WORKFLOW or run["event"] != "pull_request"
                or run["repository"]["full_name"] != repository or run["head_repository"]["full_name"] != repository
                or run["head_sha"] != os.environ["GITHUB_SHA"] or run["head_branch"] != os.environ["GITHUB_REF_NAME"]):
            raise ValueError("Fixture artifact is not from this trusted branch's PR workflow")
        archive = directory.with_suffix(".zip")
        try:
            handoff.download(repository, artifact, archive)
            handoff.unpack(archive, directory, ["fixture.json", "amd64.oci.tar", "arm64.oci.tar"], 10 * 1024**2)
        finally:
            archive.unlink(missing_ok=True)
        proof = json.loads((directory / "fixture.json").read_text())
        if proof.get("fixture") is not True or proof["head_sha"] != os.environ["GITHUB_SHA"]:
            raise ValueError("Fixture identity mismatch")
        print("Existing read-scoped App token downloaded and verified the cross-run fixture archive.")
    elif mode == "load":
        proof = json.loads((directory / "fixture.json").read_text())
        if proof.get("fixture") is not True or proof["head_sha"] != os.environ["GITHUB_SHA"]:
            raise ValueError("Fixture source mismatch")
        for arch in ("amd64", "arm64"):
            image_id = proof["images"][arch]["image_id"]
            reference = f"handoff-fixture:loaded-{arch}"
            subprocess.run(["skopeo", "copy", "--override-os", "linux", "--override-arch", arch,
                            "oci-archive:" + str(directory / f"{arch}.oci.tar"),
                            "docker-archive:" + str(directory / f"{arch}.scan.tar") + ":" + reference], check=True)
            subprocess.run(["docker", "load", "--input", str(directory / f"{arch}.scan.tar")], check=True)
            (directory / f"{arch}.scan.tar").unlink()
            module("release-candidate").inspect_image(reference, image_id, arch)
            oci = directory / f"{arch}.oci.tar"
            if handoff.digest(oci) != proof["images"][arch]["oci_digest"]:
                raise ValueError("OCI fixture payload changed")
            expected = module("release-oci").inspect(oci, image_id, arch)
            if expected != proof["images"][arch]["oci"]:
                raise ValueError("Original fixture provenance changed")
            layout = directory / f"{arch}-layout"
            subprocess.run(["skopeo", "copy", "--all", "--preserve-digests", "oci-archive:" + str(oci),
                            f"oci:{layout}:fixture"], check=True)
            copied = directory / f"{arch}-copied.oci.tar"
            with tarfile.open(copied, "w") as output:
                output.add(layout, arcname=".")
            if module("release-oci").inspect(copied, image_id, arch) != expected:
                raise ValueError("OCI transport changed runtime or provenance manifests")
        print("Both scratch-image configs, rootfs archives and original provenance survived the handoff and OCI transport.")
    else:
        raise ValueError("Unknown fixture operation")


if __name__ == "__main__":
    main()
