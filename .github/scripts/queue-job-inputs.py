"""Decide which merge-queue jobs a merge group's diff can affect.

Prints one `name=true|false` line per job family for $GITHUB_OUTPUT. A family
is skipped only when every changed path is known not to reach it; an empty
diff, an unknown path, or a failed diff runs it.
"""

import subprocess
import sys

# Shared CI plumbing that can change how any job family behaves.
CI_INPUTS = (
    ".github/workflows/on-pull-requests.yml",
    ".github/actions/",
    ".github/scripts/queue-job-inputs.py",
)

# Agent instructions and other repository prose no build or test reads.
PROSE = (".agents/", ".claude/", ".codex/")


def backend(path):
    """Backend unit tests and the real-PostgreSQL OpenAPPA suite.

    A skip list: frontend, docs prose, e2e specs, the MCP catalog, ai-labs,
    agent instructions and top-level Markdown are never read. The e2e
    fixtures the backend tests import, and docs/openapi.json (which codegen
    writes), still run them.
    """
    if path == "docs/openapi.json" or path.startswith("platform/e2e-tests/fixtures/"):
        return True
    if "/" not in path and path.endswith(".md"):
        return False
    return not path.startswith((
        "platform/frontend/", "platform/e2e-tests/", "docs/", "mcp-catalog/", "ai-labs/",
    ) + PROSE)


def frontend(path):
    """Frontend MSW integration tests.

    They run the Next dev server against MSW mocks and import only
    platform/frontend and @archestra/shared, never the backend, the Rust
    crates, or a running stack. docs/openapi.json feeds the shared client
    codegen, so it still runs them.
    """
    if path == "docs/openapi.json":
        return True
    if "/" not in path and path.endswith(".md"):
        return False
    return not path.startswith((
        "platform/backend/", "platform/archestra-rs/", "platform/e2e-tests/",
        "platform/helm/", "docs/", "mcp-catalog/", "ai-labs/",
    ) + PROSE)


def platform_rust(path):
    """Platform Rust checks: a run list over the Rust workspace and its toolchain.

    Mirrors the inputs that warm-rust-check-caches.yml publishes caches for.
    The Dagger version sync these checks used to carry now runs in the lint
    job, so its inputs elsewhere in the tree no longer matter here.
    """
    return path.startswith(("platform/archestra-rs/",) + CI_INPUTS) or path == "platform/rust-toolchain.toml"


def ai_labs(path):
    """AI Labs Rust checks: the ai-labs workspace and its triage parity fixture."""
    return path.startswith((
        "ai-labs/", ".agents/skills/archestra-dev-bench-analysis/",
    ) + CI_INPUTS)


def archestra_cli(path):
    """Archestra CLI checks: the archestra program workspace and the toolchain it pins.

    The release lock in that directory pins published binaries for the
    platform image; Cargo never reads it.
    """
    if path == "platform/archestra-cli/release.lock.json":
        return False
    return path.startswith(("platform/archestra-cli/",) + CI_INPUTS) or path == "platform/rust-toolchain.toml"


FAMILIES = {
    "backend": backend,
    "frontend": frontend,
    "platform_rust": platform_rust,
    "ai_labs": ai_labs,
    "archestra_cli": archestra_cli,
}


def classify(paths):
    if not paths:
        return {name: True for name in FAMILIES}
    return {name: any(test(path) for path in paths) for name, test in FAMILIES.items()}


if __name__ == "__main__":
    # Include both names of renames: moving a file out of a job's inputs must
    # not hide its deletion. A diff failure exits nonzero, and the consumers
    # then run rather than skip.
    changed = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", sys.argv[1], sys.argv[2]]
    ).decode("utf-8", errors="surrogateescape").split("\0")
    for name, run in classify([path for path in changed if path]).items():
        print(f"{name}={'true' if run else 'false'}")
