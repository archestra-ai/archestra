"""Decide which agent catalog images a diff can affect.

Prints a JSON array of Dockerfile targets for the validation matrix in
build-agent-catalog-images.yml. A target is left out only when every changed
path is known not to reach it: the shared base stage, a file without an
agent's name, an unknown path, or a failed diff selects every target.

Usage: agent-image-inputs.py <base-sha> <head-sha>
"""

import json
import re
import subprocess
import sys

DOCKERFILE = "platform/docker_images/agent/Dockerfile"
AGENT_DIR = "platform/docker_images/agent/"

# Dockerfile target -> the name its own files carry in bin/, tests/ and
# patches/ (archestra-kimi-hook, kimi-user-mcp-only.py, copilot.py, ...).
TARGETS = {
    "agent-claude-code": "claude",
    "agent-codex": "codex",
    "agent-opencode": "opencode",
    "agent-hermes": "hermes",
    "agent-openclaw": "openclaw",
    "agent-grok": "grok",
    "agent-kimi": "kimi",
    "agent-copilot": "copilot",
}

# Builder stages that only one target copies from.
STAGE_OWNERS = {"uv-hermes": "agent-hermes"}

# What the images are built from, besides the agent directory: the shared
# workspace helper, the build context's ignore file, and the workflows and
# actions that build them. A change here reaches every image.
SHARED_INPUTS = (
    "platform/backend/src/static/workspace-files.py",
    "platform/.dockerignore",
    ".github/workflows/build-agent-catalog-images.yml",
    ".github/workflows/build-native-multi-arch-image.yml",
    ".github/actions/build-docker-image/",
    ".github/actions/setup-docker-builder/",
    ".github/scripts/agent-image-inputs.py",
)

# Read by no image build: the directory's prose.
PROSE = {AGENT_DIR + "README.md", AGENT_DIR + "runtime-contract.md"}

ALL = list(TARGETS)


def targets_for_path(path, read_dockerfile):
    """Targets one changed path can affect; ALL when it may reach the base."""
    if path.startswith(SHARED_INPUTS):
        return ALL
    if not path.startswith(AGENT_DIR) or path in PROSE:
        return []
    if path == DOCKERFILE:
        return dockerfile_targets(*read_dockerfile())
    if path.startswith(AGENT_DIR + "openclaw/"):
        return ["agent-openclaw"]
    for directory, pattern in (
        ("bin/", r"archestra-{}(?:-|$)"),
        ("tests/", r"{}(?:-|\.)"),
        ("patches/", r"{}-"),
    ):
        if path.startswith(AGENT_DIR + directory):
            name = path[len(AGENT_DIR + directory):]
            for target, key in TARGETS.items():
                if re.match(pattern.format(re.escape(key)), name):
                    return [target]
            return ALL
    # The rest of the agent directory reaches the shared base.
    return ALL


def dockerfile_targets(before, after):
    """Targets whose stages differ; ALL when a shared stage changed."""
    old, new = stages(before), stages(after)
    selected = []
    for name in sorted(set(old) | set(new)):
        if old.get(name) == new.get(name):
            continue
        owner = name if name in TARGETS else STAGE_OWNERS.get(name)
        if owner is None:
            return ALL
        selected.append(owner)
    return selected


def stages(text):
    """Dockerfile text split by stage name; '' holds what precedes the first FROM."""
    result, name, lines = {}, "", []
    for line in (text or "").splitlines():
        match = re.match(r"\s*FROM\s+.*\s+AS\s+(\S+)\s*$", line, re.IGNORECASE)
        if match:
            result[name] = "\n".join(lines)
            name, lines = match.group(1), []
        lines.append(line)
    result[name] = "\n".join(lines)
    return result


def classify(paths, read_dockerfile):
    if not paths:
        return ALL
    selected = set()
    for path in paths:
        selected.update(targets_for_path(path, read_dockerfile))
        if len(selected) == len(TARGETS):
            break
    return [target for target in TARGETS if target in selected]


def git_show(sha, path):
    result = subprocess.run(
        ["git", "show", f"{sha}:{path}"], capture_output=True, text=True
    )
    # A missing file (added or deleted Dockerfile) compares as empty.
    return result.stdout if result.returncode == 0 else ""


if __name__ == "__main__":
    base, head = sys.argv[1], sys.argv[2]
    # Both names of renames, so moving a file out of an image's inputs still
    # counts. A diff failure exits nonzero, and the workflow then builds all.
    changed = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, head]
    ).decode("utf-8", errors="surrogateescape").split("\0")
    print(json.dumps(classify(
        [path for path in changed if path],
        lambda: (git_show(base, DOCKERFILE), git_show(head, DOCKERFILE)),
    )))
