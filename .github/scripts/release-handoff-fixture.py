#!/usr/bin/env python3
"""Harmless scratch-image handoff rehearsal; no scans, registry pushes or releases."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys


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
            subprocess.run(["docker", "build", "--network", "none", "--platform", f"linux/{arch}",
                            "--tag", reference, str(context)], check=True)
            subprocess.run(["docker", "save", "--output", str(directory / f"{arch}.tar"), reference], check=True)
            image_id = handoff.command("docker", "image", "inspect", reference, "--format", "{{.Id}}")
            module("release-candidate").inspect_image(reference, image_id, arch)
            proof["images"][arch] = {"image_id": image_id, "digest": handoff.digest(directory / f"{arch}.tar")}
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
            handoff.unpack(archive, directory, ["fixture.json", "amd64.tar", "arm64.tar"], 10 * 1024**2)
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
            archive = directory / f"{arch}.tar"
            if handoff.digest(archive) != proof["images"][arch]["digest"]:
                raise ValueError("Fixture payload changed during handoff")
            subprocess.run(["docker", "load", "--input", str(archive)], check=True)
            image_id = proof["images"][arch]["image_id"]
            module("release-candidate").inspect_image(image_id, image_id, arch)
        print("Both scratch-image configs and rootfs archives survived the cross-run and same-run handoff.")
    else:
        raise ValueError("Unknown fixture operation")


if __name__ == "__main__":
    main()
