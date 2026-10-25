"""Publish captured images once, respecting GitHub's immutable queued head."""

import os
import subprocess
import sys


def push(branch):
    result = subprocess.run(
        ["git", "push", "origin", f"HEAD:refs/heads/{branch}"],
        capture_output=True, text=True,
    )
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    # Only GitHub's explicit queue lock makes publication unnecessary. Other
    # protection, authentication and non-fast-forward failures stay failures.
    if result.returncode and all(message in result.stderr for message in (
        "remote: error: GH006: Protected branch update failed",
        "A pull request for this branch has been added to a merge queue.",
        "are queued for merging cannot be updated.",
    )):
        if output := os.environ.get("GITHUB_OUTPUT"):
            with open(output, "a") as stream:
                stream.write("queued=true\n")
        print("PR is queued; retaining validated screenshot artifacts and the queued head.")
        return 0
    return result.returncode


if __name__ == "__main__":
    sys.exit(push(sys.argv[1]))
