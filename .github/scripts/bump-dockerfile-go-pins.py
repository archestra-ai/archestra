"""Bump the Go modules that Dockerfiles pin with `go get module@vX.Y.Z`.

Those pins patch the third-party CLIs built into the release images (docker,
dagger, kind, kubectl, git tooling) past a vulnerable dependency. Dependabot
reads go.mod files only, so nothing else ever moves them.

Each pinned module moves to its newest release in the same major version
(the module path names the major) that is not a pre-release and was
published at least MIN_AGE_DAYS ago, the repository's release-age rule. A pin
never moves down. Every pin of a module, in every Dockerfile, gets the same
version.

    python3 .github/scripts/bump-dockerfile-go-pins.py [--check] [--patch-only] [--root DIR]

Prints one "module old -> new" line per bump and rewrites the Dockerfiles;
--check only prints. --patch-only, for a release line, keeps a v1+ module on
its minor version; a v0 module may still take a new minor, which is how
golang.org/x modules ship their fixes. --root is the checkout whose
Dockerfiles to read (default: this script's own). bump-dockerfile-go-pins.yml runs it weekly for main and
the supported release line.
"""
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DOCKERFILES = ("platform/Dockerfile", "platform/docker_images/agent/Dockerfile")
MIN_AGE_DAYS = 7
# One `go get` command and its module@version arguments; PIN finds each
# argument, so every module on a multi-module line is bumped, not just the first.
GO_GET = re.compile(r"go get(?: +[A-Za-z0-9./_~-]+@v[0-9]+\.[0-9]+\.[0-9]+(?=[\s\\&;]|$))+")
PIN = re.compile(r"([A-Za-z0-9./_~-]+)@(v[0-9]+\.[0-9]+\.[0-9]+)")
SEMVER = re.compile(r"v([0-9]+)\.([0-9]+)\.([0-9]+)")
PROXY = "https://proxy.golang.org"


def main(argv, root=None, fetch=None, now=None):
    if "--root" in argv:
        root = Path(argv[argv.index("--root") + 1])
    root = root or Path(__file__).resolve().parents[2]
    fetch = fetch or proxy
    now = now or datetime.datetime.now(datetime.timezone.utc)
    files = {name: (root / name).read_text() for name in DOCKERFILES if (root / name).exists()}
    bumps = plan(files, fetch, now, patch_only="--patch-only" in argv[1:])
    for module, (old, new) in sorted(bumps.items()):
        print(f"{module} {old} -> {new}")
    if "--check" not in argv[1:]:
        for name, text in files.items():
            (root / name).write_text(rewrite(text, bumps))
    return bumps


def plan(files, fetch, now, patch_only=False):
    """module -> (lowest pinned version, version to pin) for each module that moves."""
    pinned = {}
    for text in files.values():
        for command in GO_GET.findall(text):
            for module, version in PIN.findall(command):
                pinned.setdefault(module, set()).add(version)
    bumps = {}
    for module, versions in pinned.items():
        current = max(versions, key=key)
        goal = newest(module, current, fetch, now, patch_only) or current
        if versions != {goal}:
            bumps[module] = (min(versions, key=key), goal)
    return bumps


def rewrite(text, bumps):
    def pin(m):
        return f"{m[1]}@{bumps[m[1]][1]}" if m[1] in bumps else m[0]
    return GO_GET.sub(lambda command: PIN.sub(pin, command[0]), text)


def newest(module, current, fetch, now, patch_only=False):
    major, minor, _ = key(current)
    cutoff = now - datetime.timedelta(days=MIN_AGE_DAYS)
    candidates = sorted((v for v in fetch(f"{escape(module)}/@v/list").split()
                         if SEMVER.fullmatch(v) and key(v)[0] == major
                         and not (patch_only and major > 0 and key(v)[1] != minor)),
                        key=key, reverse=True)
    for version in candidates:
        if key(version) <= key(current):
            return None
        published = json.loads(fetch(f"{escape(module)}/@v/{version}.info"))["Time"]
        if datetime.datetime.fromisoformat(published.replace("Z", "+00:00")) <= cutoff:
            return version
    return None


def key(version):
    return tuple(int(part) for part in SEMVER.fullmatch(version).groups())


def escape(module):
    """The module proxy's path encoding: an upper-case letter becomes !lower."""
    return re.sub(r"[A-Z]", lambda m: "!" + m[0].lower(), module)


def proxy(path):
    with urllib.request.urlopen(f"{PROXY}/{urllib.parse.quote(path, safe='/!~')}", timeout=30) as response:
        return response.read().decode()


if __name__ == "__main__":
    main(sys.argv)
