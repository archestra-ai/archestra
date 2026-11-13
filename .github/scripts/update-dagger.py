#!/usr/bin/env python3
"""Move every Dagger pin to the newest stable upstream release past the cooldown.

The engine image, the CLI built into platform/Dockerfile, the vendored Rust SDK
and the CI fixtures must move together (platform/scripts/check-dagger-version-sync.sh).
Every new value is resolved from upstream and verified before any file changes:

- the release tag's commit, from the GitHub API;
- the engine's multi-architecture index digest, from registry.dagger.io, which
  is also the base of the patched dagger-engine target in platform/Dockerfile;
- the runc release Dagger's own engine build pins, and that tag's commit;
- the stock linux/amd64 CLI checksum, from the release's checksums.txt;
- the dagger-sdk crate, from crates.io, checked against its published checksum.

The vendored SDK keeps a hand-normalized manifest (see its header). The updater
copies the new crate's sources and carries that manifest forward only when the
published manifests of the old and new crates are identical apart from the
version, and the vendored sources still match the old crate byte for byte.
Anything else stops the update for a human to redo the normalization.
"""

import argparse
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.error
import urllib.request


STABLE = re.compile(r"\d+\.\d+\.\d+")
SHA256 = re.compile(r"[0-9a-f]{64}")
COMMIT = re.compile(r"[0-9a-f]{40}")
USER_AGENT = "archestra-dagger-updater (+https://github.com/archestra-ai/archestra)"
INDEX_TYPES = ("application/vnd.oci.image.index.v1+json, "
               "application/vnd.docker.distribution.manifest.list.v2+json")

SDK_CARGO = "platform/archestra-rs/sandbox-core/Cargo.toml"
CARGO_LOCK = "platform/archestra-rs/Cargo.lock"
VENDOR_DIR = "platform/archestra-rs/vendor"
DOCKERFILE = "platform/Dockerfile"
DAGGER_DEPS = "platform/docker/dagger-deps.sh"
BENCH_JOB = ".github/bench/dagger-job.yaml"
SDK_WORKFLOW = ".github/workflows/on-pull-requests-dagger-sdk.yml"
# Every file that names the pinned Dagger version. Each must name it before and
# must not name it after the update; a file that stops naming it is a new
# layout this list has to learn about.
VERSION_FILES = (
    DOCKERFILE,
    DAGGER_DEPS,
    BENCH_JOB,
    SDK_WORKFLOW,
    "LICENSE.md",
    "ai-labs/dev/docker-compose.bench-dagger.yml",
    "platform/.gitignore",
    "platform/archestra-rs/Cargo.toml",
    SDK_CARGO,
    "platform/archestra-rs/sandbox-core/src/backends/dagger.rs",
    "platform/archestra-rs/sandbox-core/tests/live_dagger_sdk.rs",
    "platform/backend/src/config.ts",
    "platform/backend/src/k8s/dagger-environment-runtime/manager.test.ts",
    "platform/docker/dagger-engine.quickstart.yaml",
)
# The vendored tree holds exactly these crate paths; everything else in the
# published archive (examples, tests, Cargo.lock) is not vendored.
VENDORED = ("src", "README.md", "LICENSE")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="Repository checkout to update")
    parser.add_argument("--cooldown-days", type=float, default=7.0,
                        help="Minimum age of an upstream release, matching minimumReleaseAge")
    parser.add_argument("--now", help="ISO-8601 clock override for tests")
    args = parser.parse_args()
    now = dt.datetime.fromisoformat(args.now) if args.now else dt.datetime.now(dt.timezone.utc)
    if args.cooldown_days < 0 or now.tzinfo is None:
        raise ValueError("Invalid cooldown or clock")

    root = args.root.resolve()
    current = current_version(root)
    upstream = Upstream()
    target = newest_release(upstream, current, now - dt.timedelta(days=args.cooldown_days))
    if target is None:
        print(f"Dagger {current} is already the newest release outside the cooldown")
        return
    old = Pins.read(root, current)
    new = Pins.resolve(upstream, target)
    old_crate = Crate.download(upstream, current)
    new_crate = Crate.download(upstream, target)
    vendor = root / VENDOR_DIR / f"dagger-sdk-{current}"
    check_vendor(vendor, old_crate, new_crate)

    rewrite(root, old, new)
    revendor(vendor, root / VENDOR_DIR / f"dagger-sdk-{target}", old, new, new_crate)
    subprocess.run(["sh", str(root / "platform/scripts/check-dagger-version-sync.sh")], check=True)
    note = upstream.go_directive(new.commit)
    if note:
        print(f"Upstream go.mod at v{target} declares go {note}; "
              f"{DAGGER_DEPS} aligns the module directive to {dockerfile_go(root)}")
    if new.runc_version != old.runc_version:
        print(f"runc follows Dagger's engine build: {old.runc_version} -> {new.runc_version}")
    print(f"Updated Dagger {current} -> {target}")


# =============================================================================
# Internal helpers
# =============================================================================

class Upstream:
    """HTTP access to GitHub, registry.dagger.io and crates.io, overridable for tests."""

    def __init__(self):
        self.github_api = os.environ.get("DAGGER_UPDATER_GITHUB_API", "https://api.github.com").rstrip("/")
        self.github = os.environ.get("DAGGER_UPDATER_GITHUB", "https://github.com").rstrip("/")
        self.registry = os.environ.get("DAGGER_UPDATER_REGISTRY", "https://registry.dagger.io").rstrip("/")
        self.crates = os.environ.get("DAGGER_UPDATER_CRATES", "https://crates.io").rstrip("/")
        self.raw = os.environ.get("DAGGER_UPDATER_RAW", "https://raw.githubusercontent.com").rstrip("/")
        self.token = os.environ.get("GH_TOKEN", "")

    def releases(self):
        return self.json(f"{self.github_api}/repos/dagger/dagger/releases?per_page=100", github=True)

    def commit(self, tag, repo="dagger/dagger"):
        ref = self.json(f"{self.github_api}/repos/{repo}/git/ref/tags/{tag}", github=True)["object"]
        if ref["type"] == "tag":
            ref = self.json(f"{self.github_api}/repos/{repo}/git/tags/{ref['sha']}", github=True)["object"]
        if ref["type"] != "commit" or not COMMIT.fullmatch(ref["sha"]):
            raise ValueError(f"{repo} {tag} does not resolve to a commit")
        return ref["sha"]

    def runc_version(self, commit):
        """The runc release Dagger's own engine build pins at this commit."""
        text = self.get(f"{self.raw}/dagger/dagger/{commit}/toolchains/engine-dev/consts/consts.go").decode()
        versions = re.findall(r'^\s*RuncVersion\s*=\s*"(v\d+\.\d+\.\d+)"', text, re.M)
        if len(versions) != 1:
            raise ValueError("Dagger's engine build does not pin a single runc version")
        return versions[0]

    def cli_checksum(self, version):
        name = f"dagger_v{version}_linux_amd64.tar.gz"
        text = self.get(f"{self.github}/dagger/dagger/releases/download/v{version}/checksums.txt").decode()
        sums = [line.split()[0] for line in text.splitlines() if line.split()[1:] == [name]]
        if len(sums) != 1 or not SHA256.fullmatch(sums[0]):
            raise ValueError(f"checksums.txt for v{version} has no single checksum for {name}")
        return sums[0]

    def engine_digest(self, version):
        body, headers = self.get(f"{self.registry}/v2/engine/manifests/v{version}",
                                 accept=INDEX_TYPES, with_headers=True)
        digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
        if headers.get("Docker-Content-Digest", digest) != digest:
            raise ValueError("Engine index bytes do not match the registry digest")
        index = json.loads(body)
        platforms = {(m.get("platform", {}).get("os"), m.get("platform", {}).get("architecture"))
                     for m in index.get("manifests", [])}
        for arch in ("amd64", "arm64"):
            if ("linux", arch) not in platforms:
                raise ValueError(f"Engine v{version} index has no linux/{arch} image")
        return digest

    def crate(self, version):
        meta = self.json(f"{self.crates}/api/v1/crates/dagger-sdk/{version}")["version"]
        if meta.get("yanked") or not SHA256.fullmatch(meta.get("checksum", "")):
            raise ValueError(f"dagger-sdk {version} is yanked or has no checksum")
        archive = self.get(f"{self.crates}/api/v1/crates/dagger-sdk/{version}/download")
        if hashlib.sha256(archive).hexdigest() != meta["checksum"]:
            raise ValueError(f"dagger-sdk {version} archive does not match its published checksum")
        return archive, meta["checksum"]

    def go_directive(self, commit):
        try:
            text = self.get(f"{self.raw}/dagger/dagger/{commit}/go.mod").decode()
        except (urllib.error.URLError, OSError):
            return None
        match = re.search(r"^go\s+(\S+)\s*$", text, re.M)
        return match.group(1) if match else None

    def json(self, url, github=False):
        return json.loads(self.get(url, github=github))

    def get(self, url, accept=None, github=False, with_headers=False):
        headers = {"User-Agent": USER_AGENT}
        if accept:
            headers["Accept"] = accept
        if github:
            headers["Accept"] = "application/vnd.github+json"
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as response:
            body = response.read()
            return (body, response.headers) if with_headers else body


class Pins:
    """The values a Dagger bump changes besides the version string itself."""

    def __init__(self, version, commit, engine_digest, cli_checksum, runc_version, runc_commit):
        self.version, self.commit = version, commit
        self.engine_digest, self.cli_checksum = engine_digest, cli_checksum
        self.runc_version, self.runc_commit = runc_version, runc_commit

    @classmethod
    def read(cls, root, version):
        dockerfile = (root / DOCKERFILE).read_text()
        bench = (root / BENCH_JOB).read_text()
        workflow = (root / SDK_WORKFLOW).read_text()
        commit = one(r"^ARG DAGGER_COMMIT=([0-9a-f]{40})$", dockerfile, "DAGGER_COMMIT")
        digest = one(rf"registry\.dagger\.io/engine:v{re.escape(version)}@(sha256:[0-9a-f]{{64}})",
                     bench, "benchmark engine digest")
        checksum = one(rf"dagger_v{re.escape(version)}_linux_amd64\.tar\.gz \\\n\s+--output .*\n"
                       r"\s+printf .*\n\s+([0-9a-f]{64}) \\$", workflow, "SDK fixture CLI checksum")
        if digest not in workflow or digest not in dockerfile:
            raise ValueError("The SDK fixture, Dockerfile and benchmark Job pin different engine digests")
        runc_version = one(r"^ARG RUNC_VERSION=(v\d+\.\d+\.\d+)$", dockerfile, "RUNC_VERSION")
        runc_commit = one(r"^ARG RUNC_COMMIT=([0-9a-f]{40})$", dockerfile, "RUNC_COMMIT")
        return cls(version, commit, digest, checksum, runc_version, runc_commit)

    @classmethod
    def resolve(cls, upstream, version):
        commit = upstream.commit(f"v{version}")
        runc_version = upstream.runc_version(commit)
        return cls(version, commit, upstream.engine_digest(version), upstream.cli_checksum(version),
                   runc_version, upstream.commit(runc_version, repo="opencontainers/runc"))


class Crate:
    def __init__(self, version, checksum, files):
        self.version, self.checksum, self.files = version, checksum, files

    @classmethod
    def download(cls, upstream, version):
        archive, checksum = upstream.crate(version)
        prefix = f"dagger-sdk-{version}/"
        files = {}
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
            for member in tar.getmembers():
                if not member.name.startswith(prefix) or ".." in Path(member.name).parts:
                    raise ValueError(f"Unexpected path in dagger-sdk {version}: {member.name}")
                if member.isfile():
                    files[member.name[len(prefix):]] = tar.extractfile(member).read()
                elif not member.isdir():
                    raise ValueError(f"Unexpected entry type in dagger-sdk {version}: {member.name}")
        return cls(version, checksum, files)

    def vendored(self):
        return {path: data for path, data in self.files.items()
                if path in VENDORED or path.startswith("src/")}

    def manifest(self):
        text = self.files["Cargo.toml"].decode()
        return re.sub(rf'^version = "{re.escape(self.version)}"$', 'version = "<version>"', text, count=1, flags=re.M)


def current_version(root):
    return one(r'^dagger-sdk = "=(\d+\.\d+\.\d+)"$', (root / SDK_CARGO).read_text(), "dagger-sdk pin")


def newest_release(upstream, current, cutoff):
    candidates = []
    for release in upstream.releases():
        tag = release.get("tag_name", "")
        if (release.get("draft") or release.get("prerelease") or not tag.startswith("v")
                or not STABLE.fullmatch(tag[1:])):
            continue
        published = dt.datetime.fromisoformat(release["published_at"].replace("Z", "+00:00"))
        if key(tag[1:]) > key(current) and published <= cutoff:
            candidates.append(tag[1:])
    return max(candidates, key=key, default=None)


def check_vendor(vendor, old_crate, new_crate):
    local = {str(path.relative_to(vendor)): path.read_bytes()
             for path in vendor.rglob("*") if path.is_file() and path.name != "Cargo.toml"}
    if local != old_crate.vendored():
        raise ValueError(f"{vendor.name} no longer matches the published dagger-sdk {old_crate.version}; "
                         "carry its local changes forward by hand")
    if old_crate.manifest() != new_crate.manifest():
        raise ValueError(f"dagger-sdk {new_crate.version} changed its published manifest; "
                         f"re-normalize the vendored Cargo.toml by hand (see the header in {vendor.name})")
    if not new_crate.vendored().keys() >= {"README.md", "LICENSE", "src/lib.rs"}:
        raise ValueError(f"dagger-sdk {new_crate.version} is missing vendored files")


def rewrite(root, old, new):
    version = re.compile(rf"(?<![0-9.]){re.escape(old.version)}(?![0-9])")
    for name in VERSION_FILES:
        path = root / name
        text = path.read_text()
        updated, count = version.subn(new.version, text)
        if not count:
            raise ValueError(f"{name} no longer names Dagger {old.version}; update VERSION_FILES")
        for before, after in ((old.commit, new.commit), (old.engine_digest, new.engine_digest),
                              (old.cli_checksum, new.cli_checksum)):
            updated = updated.replace(before, after)
        path.write_text(updated)
    dockerfile = root / DOCKERFILE
    text = dockerfile.read_text()
    for name, before, after in (("RUNC_VERSION", old.runc_version, new.runc_version),
                                ("RUNC_COMMIT", old.runc_commit, new.runc_commit)):
        text, count = re.subn(rf"^ARG {name}={re.escape(before)}$", f"ARG {name}={after}", text, flags=re.M)
        if count != 1:
            raise ValueError(f"platform/Dockerfile has no single ARG {name}")
    dockerfile.write_text(text)
    for name, value in ((DOCKERFILE, new.commit), (DOCKERFILE, new.engine_digest), (BENCH_JOB, new.engine_digest),
                        (SDK_WORKFLOW, new.engine_digest), (SDK_WORKFLOW, new.cli_checksum)):
        if value not in (root / name).read_text():
            raise ValueError(f"{name} did not receive the new pin {value}")
    lock = root / CARGO_LOCK
    text, count = re.subn(rf'(\[\[package\]\]\nname = "dagger-sdk"\nversion = "){re.escape(old.version)}"',
                          rf'\g<1>{new.version}"', lock.read_text())
    if count != 1:
        raise ValueError("Cargo.lock has no single dagger-sdk entry")
    lock.write_text(text)


def revendor(old_dir, new_dir, old, new, crate):
    manifest = (old_dir / "Cargo.toml").read_text()
    manifest, count = re.subn(rf"(?<![0-9.]){re.escape(old.version)}(?![0-9])", new.version, manifest)
    manifest = re.sub(r"^(# Archive SHA-256: )[0-9a-f]{64}$", rf"\g<1>{crate.checksum}", manifest, count=1, flags=re.M)
    if count < 2 or crate.checksum not in manifest:
        raise ValueError("The vendored manifest header or version did not update")
    shutil.rmtree(old_dir)
    for path, data in crate.vendored().items():
        target = new_dir / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    (new_dir / "Cargo.toml").write_text(manifest)


def dockerfile_go(root):
    return one(r"# dagger v\S+ vendored Go SDK requires .*\ngo mod edit -go=(\S+)$",
               (root / DAGGER_DEPS).read_text(), "Dagger go directive")


def one(pattern, text, label):
    matches = re.findall(pattern, text, re.M)
    if len(set(matches)) != 1:
        raise ValueError(f"Expected one {label}, found {len(set(matches))}")
    return matches[0]


def key(version):
    return tuple(int(part) for part in version.split("."))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, urllib.error.URLError,
            subprocess.CalledProcessError, tarfile.TarError) as error:
        sys.exit(f"Dagger update failed: {error}")
