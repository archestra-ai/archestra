#!/usr/bin/env python3
"""Prepare a provider codegen patch without credentials; publish it in a separate job.

Publication executes only this trusted platform script, git and gh. It never runs
provider code. The candidate's tests run only in the unprivileged prepare job.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

BRANCH = "automation/platform-api"
REPOSITORY = "archestra-ai/terraform-provider-archestra"
CLIENTS = ("internal/client/archestra_client.go", "internal/client/archestra_client_manual.go")
MANIFEST = "platform-api.json"


class OfflineGenerationError(ValueError):
    pass


class ClientGenerationError(ValueError):
    pass


def clean_env():
    env = os.environ | {"GOFLAGS": "-mod=readonly", "TF_ACC": ""}
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "ARCHESTRA_API_KEY", "ARCHESTRA_BASE_URL"):
        env.pop(key, None)
    return env


def verify_source(source, selected_hash):
    if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != selected_hash:
        raise OfflineGenerationError(
            "Provider main does not read OPENAPI_SPEC in make codegen-api-client; "
            "the updater needs offline generation (provider v3 or later)."
        )


def has_credential_target(makefile):
    # Inspect declarations only; never execute tooling to discover the layout.
    return bool(re.search(r"^codegen-credential-client\s*:(?!=)", makefile, re.M))


def generate_client(*, provider, spec, env):
    # The provider owns normalization, operation selection, flags and bridges.
    # Run its canonical pipeline only in the isolated trusted checkout copy.
    selected_hash = hashlib.sha256(spec.read_bytes()).hexdigest()
    credential = has_credential_target((provider / "Makefile").read_text())
    targets = ["codegen-api-client"] + (["codegen-credential-client"] if credential else [])
    result = subprocess.run(
        ["make", "-C", str(provider), *targets],
        env=env | {"OPENAPI_SPEC": str(spec.resolve()),
                   "ARCHESTRA_OPENAPI_SPEC": str(spec.resolve()),
                   "ARCHESTRA_BASE_URL": "http://127.0.0.1:9"},
    )
    # Provider main reads OPENAPI_SPEC, so a failed make is a codegen failure,
    # even when it stops before writing the raw spec.
    if result.returncode:
        raise ClientGenerationError(
            f"Client generation failed for the selected spec (make exit {result.returncode}); "
            "the provider's codegen must handle this API change."
        )
    verify_source(provider / ".codegen/openapi.raw.json", selected_hash)
    if credential:
        verify_source(provider / ".codegen/credentials-source.json", selected_hash)
    print(f"All generated-client source SHA256 hashes match the selected spec: {selected_hash}", flush=True)


def clients(makefile):
    return CLIENTS if has_credential_target(makefile) else CLIENTS[:1]


def git(repo, *args, check=True):
    return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args],
                          check=check, text=True, capture_output=True)


def sha(value):
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("Expected a full commit SHA")
    return value


def hashes(repo, managed):
    return {name: hashlib.sha256((repo / name).read_bytes()).hexdigest()
            if (repo / name).is_file() else None for name in managed}


def branch(repo):
    """Start from the remote update head, then merge main without discarding commits."""
    main = sha(git(repo, "rev-parse", "origin/main").stdout.strip())
    remote = git(repo, "ls-remote", "--heads", "origin", f"refs/heads/{BRANCH}").stdout.strip()
    if remote:
        head = sha(remote.split()[0])
        git(repo, "fetch", "origin", f"refs/heads/{BRANCH}")
        git(repo, "checkout", "-b", "provider-update", head)
    else:
        head = main
        git(repo, "checkout", "-b", "provider-update", main)
    return {"head": head, "main": main, "existed": bool(remote)}


def generate(tools, candidate, spec):
    # Tools and configs come from provider main, never from the human update branch.
    with tempfile.TemporaryDirectory(prefix="provider-codegen-") as work:
        copy = Path(work) / "provider"
        shutil.copytree(tools, copy, ignore=shutil.ignore_patterns(".git", ".codegen", "crossplane"))
        generate_client(provider=copy, spec=spec, env=clean_env())
        for name in clients((tools / "Makefile").read_text()):
            shutil.copyfile(copy / name, candidate / name)


def set_ready(ready):
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"ready={str(ready).lower()}\n")


def prepare(args):
    repo, out = args.provider.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    try:
        prepare_candidate(args, repo, out)
    except (ValueError, subprocess.CalledProcessError) as error:
        (out / "error.txt").write_text(" ".join(str(error).splitlines()) + "\n")
        raise


def prepare_candidate(args, repo, out):
    tools = args.tools.resolve()
    generator_commit = sha(git(tools, "rev-parse", "HEAD").stdout.strip())
    candidate_main = sha(git(repo, "rev-parse", "origin/main").stdout.strip())
    if generator_commit != candidate_main:
        raise ValueError("Trusted tools and candidate origin/main revisions differ; rerun with matching checkouts")
    if git(tools, "status", "--porcelain").stdout.strip():
        raise ValueError("Trusted generator checkout must be clean")
    managed = (*clients((tools / "Makefile").read_text()), "platform-version.txt")
    allowed = (*managed, MANIFEST)
    if not (tools / "platform-version.txt").is_file():
        reason = "Provider main needs a change adding platform-version.txt and using it as the acceptance target before enabling this updater"
        (out / "result.json").write_text(json.dumps({"skipped": reason}, indent=2) + "\n")
        print(f"::warning::{reason}")
        set_ready(False)
        return
    metadata = branch(repo)
    spec = args.spec.resolve()
    spec_hash = hashlib.sha256(spec.read_bytes()).hexdigest()
    version = json.loads(spec.read_text())["info"]["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid platform version")
    if not (repo / "platform-version.txt").is_file():
        raise ValueError("Provider update branch needs platform-version.txt; merge the provider change adding that acceptance target")
    prior = json.loads((repo / MANIFEST).read_text()) if (repo / MANIFEST).exists() else None
    before = hashes(repo, managed)
    if metadata["existed"] and prior is None:
        raise ValueError("Existing automation branch has no provenance manifest; inspect it manually")
    # Same-input reruns preserve even human fixes inside generated files. On a
    # new target, refuse to overwrite those fixes; a maintainer must reconcile.
    same = (metadata["existed"] and prior is not None and prior["spec_sha256"] == spec_hash
            and prior.get("generator_commit") == generator_commit)
    if metadata["existed"] and prior and not same and before != prior["files"]:
        raise ValueError("Human changes to generated files/version detected; reconcile the new target manually")
    git(repo, "merge", "--no-edit", metadata["main"])
    metadata["tree"] = git(repo, "rev-parse", "HEAD^{tree}").stdout.strip()
    baseline = hashes(repo, managed)
    if not same:
        generate(tools, repo, spec)
        (repo / "platform-version.txt").write_text(version + "\n")
        if hashes(repo, managed) != baseline:
            (repo / MANIFEST).write_text(json.dumps({
                "platform_commit": sha(args.platform_commit), "version": version,
                "spec_sha256": spec_hash, "generator_commit": generator_commit, "files": hashes(repo, managed),
            }, indent=2) + "\n")
    git(repo, "add", "--", *[p for p in allowed if (repo / p).exists()])
    patch = subprocess.check_output(["git", "-C", str(repo), "diff", "--cached", "--binary", "HEAD", "--", *allowed])
    # Test failure is evidence attached to the PR, not a prerequisite for repair.
    with (out / "tests.log").open("w") as log:
        tests = subprocess.run(["go", "-C", str(repo), "test", "./...", "-count=1", "-timeout=120s"],
                               env=clean_env(), stdout=log, stderr=subprocess.STDOUT)
    metadata.update({"test_exit": tests.returncode, "changed": bool(patch),
                     "generator_commit": generator_commit,
                     "platform_commit": sha(args.platform_commit), "version": version})
    # Keep the prepared patch in memory until unprivileged candidate tests exit.
    (out / "update.patch").write_bytes(patch)
    (out / "result.json").write_text(json.dumps(metadata, indent=2) + "\n")
    set_ready(True)
    print(json.dumps(metadata))


def publish(args):
    repo, artifact = args.provider.resolve(), args.output.resolve()
    result = json.loads((artifact / "result.json").read_text())
    for field in ("head", "main", "tree", "platform_commit"):
        sha(result[field])
    # Derive the publication allowlist from trusted main, never repair-branch code.
    makefile = git(repo, "show", f"{result['main']}:Makefile").stdout
    allowed = (*clients(makefile), "platform-version.txt", MANIFEST)
    current = branch(repo)
    if current != {key: result[key] for key in ("head", "main", "existed")}:
        raise ValueError("Provider branch/main moved during generation; rerun to preserve concurrent changes")
    git(repo, "merge", "--no-edit", result["main"])
    if git(repo, "rev-parse", "HEAD^{tree}").stdout.strip() != result["tree"]:
        raise ValueError("Prepared tree mismatch")
    patch = artifact / "update.patch"
    if patch.stat().st_size:
        # Apply only ordinary files under the narrow allowlist, never hooks,
        # workflows, symlinks or arbitrary executable artifacts.
        git(repo, "apply", "--index", "--", str(patch))
        entries = git(repo, "diff", "--cached", "--raw", "--no-renames").stdout.splitlines()
        for entry in entries:
            info, name = entry.split("\t")
            old_mode, mode = info.split()[:2]
            if name not in allowed or old_mode not in (":000000", ":100644") or mode != "100644":
                raise ValueError("Artifact changed a forbidden path or file mode: " + name)
        git(repo, "commit", "-m", "chore: synchronize platform API client")
    different = git(repo, "diff", "--quiet", result["main"], "HEAD", check=False)
    if different.returncode == 0:
        print("No provider changes; no commit, push or pull request needed.")
        return
    if different.returncode != 1:
        raise RuntimeError(different.stderr)
    # Normal push rejects races. Never force, reset, or recreate a human branch.
    git(repo, "push", "origin", f"HEAD:refs/heads/{BRANCH}")
    body = artifact / "pr-body.md"
    outcome = "passed" if result["test_exit"] == 0 else f"FAILED (exit {result['test_exit']})"
    body.write_text(
        f"Synchronize generated clients and acceptance target with platform `{result['platform_commit']}` "
        f"(version `{result['version']}`).\n\nProvider compile/unit tests: **{outcome}**. "
        "Generated code cannot implement semantic API migrations. Commit those fixes to this branch; "
        "automation preserves resource code and refuses conflicting generated-file changes. "
        "This PR is not auto-merged.\n\n"
        f"Generation and full test log: {args.run_url}\n")
    query = subprocess.check_output(["gh", "pr", "list", "--repo", REPOSITORY, "--state", "open",
                                     "--head", BRANCH, "--base", "main", "--json", "number", "--jq", ".[0].number // empty"], text=True).strip()
    if query:
        # Preserve human PR descriptions; update only a bot-owned report comment.
        pages = json.loads(subprocess.check_output([
            "gh", "api", f"repos/{REPOSITORY}/issues/{query}/comments", "--paginate", "--slurp"], text=True))
        comments = [comment for page in pages for comment in page]
        marker = "<!-- terraform-provider-codegen -->"
        existing = next((c for c in comments if c["body"].startswith(marker) and c["user"]["type"] == "Bot"), None)
        payload = artifact / "comment.json"
        payload.write_text(json.dumps({"body": marker + "\n" + body.read_text()}))
        endpoint = f"repos/{REPOSITORY}/issues/comments/{existing['id']}" if existing else f"repos/{REPOSITORY}/issues/{query}/comments"
        subprocess.run(["gh", "api", "--method", "PATCH" if existing else "POST", endpoint, "--input", str(payload)], check=True)
    else:
        closed = json.loads(subprocess.check_output([
            "gh", "pr", "list", "--repo", REPOSITORY, "--state", "closed",
            "--head", BRANCH, "--base", "main", "--limit", "100",
            "--json", "headRefOid,mergedAt"], text=True))
        head = git(repo, "rev-parse", "HEAD").stdout.strip()
        if any(pr["headRefOid"] == head and pr["mergedAt"] is None for pr in closed):
            print(f"Provider update {head} was declined; no new pull request created.")
            return
        subprocess.run(["gh", "pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", BRANCH,
                        "--title", "chore: synchronize platform API client", "--body-file", str(body)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "publish"))
    parser.add_argument("--provider", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tools", type=Path)
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--platform-commit")
    parser.add_argument("--run-url", default="See the workflow run artifacts.")
    args = parser.parse_args()
    (prepare if args.mode == "prepare" else publish)(args)


if __name__ == "__main__":
    main()
