#!/usr/bin/env python3
"""Select each build leg's newest digest artifact across workflow rerun attempts."""

import re
import shutil
import subprocess
import sys
from pathlib import Path


def main() -> None:
    source_dir, output_dir, image_name, expected_count = sys.argv[1:]
    expected_count = int(expected_count)
    source = Path(source_dir)
    output = Path(output_dir)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    artifact_name = re.compile(rf"{re.escape(image_name)}-digests-(\d+)-(\d+)")

    selected: dict[int, tuple[int, Path]] = {}
    for artifact in source.iterdir():
        match = artifact_name.fullmatch(artifact.name)
        if not match:
            raise ValueError(f"Unexpected digest artifact: {artifact.name}")
        if not artifact.is_dir() or artifact.is_symlink():
            raise ValueError(f"Unsafe digest artifact: {artifact}")
        leg, attempt = map(int, match.groups())
        if attempt > int(__import__("os").environ["GITHUB_RUN_ATTEMPT"]):
            raise ValueError(f"Future digest artifact: {artifact.name}")
        if leg not in selected or attempt > selected[leg][0]:
            selected[leg] = (attempt, artifact)

    if set(selected) != set(range(expected_count)):
        raise ValueError(f"Incomplete digest artifact set: found {sorted(selected)}")

    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError(f"Digest output directory is not empty: {output}")

    for leg in range(expected_count):
        attempt, artifact = selected[leg]
        entries = list(artifact.iterdir())
        if len(entries) != 1 or entries[0].is_symlink() or not entries[0].is_file():
            raise ValueError(f"Invalid digest artifact: {artifact}")
        digest_file = entries[0]
        if not re.fullmatch(r"[0-9a-f]{64}", digest_file.name):
            raise ValueError(f"Invalid digest filename: {digest_file.name}")
        if digest_file.read_text().strip() != revision:
            raise ValueError(f"Digest revision mismatch: {artifact.name}")
        shutil.copyfile(digest_file, output / digest_file.name)
        print(f"Selected {image_name} build leg {leg} from attempt {attempt}")


if __name__ == "__main__":
    main()
