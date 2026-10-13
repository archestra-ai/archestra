"""Avoid recapture commit loops while retaining full screenshot validation."""

import subprocess
import sys


def should_commit(event_name):
    if event_name != "pull_request":
        return True
    subject = subprocess.check_output(
        ["git", "log", "-1", "--format=%s"], text=True
    ).strip()
    if subject != "docs: update screenshots":
        return True
    result = subprocess.run(
        ["git", "diff", "--name-only", "HEAD^", "HEAD"],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError("Cannot inspect screenshot commit's parent")
    files = result.stdout.splitlines()
    return not files or any(not file.startswith("docs/assets/") for file in files)


if __name__ == "__main__":
    print(str(should_commit(sys.argv[1])).lower())
