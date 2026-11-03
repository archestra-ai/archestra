"""Skip queue E2E only for known independent paths; unknown inputs run E2E."""

import subprocess
import sys


def run_e2e(paths):
    if not paths:
        return True
    for path in paths:
        if path.startswith(("docs/", "ai-labs/", ".agents/", ".claude/", ".codex/")):
            continue
        if "/" not in path and path.endswith(".md"):
            continue
        # Explicit independent workflows only. A new workflow is an unknown
        # input until reviewed, including any future reusable E2E workflow.
        if path in (
            ".github/workflows/pr-title-linter.yml",
            ".github/workflows/backport.yml",
            ".github/workflows/close-external-prs.yml",
            ".github/workflows/random-issue-pr-assignee.yml",
            ".github/workflows/trigger-website-deploy.yml",
        ):
            continue
        return True
    return False


if __name__ == "__main__":
    # Include both names of renames: moving a platform file outside platform
    # must not hide its deletion. Diff failures exit nonzero and block the gate.
    changed = subprocess.check_output(
        ["git", "diff", "--no-renames", "--name-only", "-z", sys.argv[1], sys.argv[2]]
    ).decode("utf-8", errors="surrogateescape").split("\0")
    print("true" if run_e2e([path for path in changed if path]) else "false")
