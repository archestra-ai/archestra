#!/usr/bin/env python3
"""Pins a release chart to the image digests released with it.

Replaces the chart's `releaseImageDigests: {}` line with
{"version": VERSION, "images": DIGESTS} before `helm package`. DIGESTS is
release-ghcr-images.json from publish-ghcr-release-images: the digests the
release-images publisher verified and copied. The platform pins its default
images to them (ARCHESTRA_RELEASE_IMAGE_DIGESTS).

Usage: VERSION=1.2.3 DIGESTS='{"mcp-server-base": "sha256:..."}' \
  release-chart-digests.py path/to/values.yaml
"""

import json
import os
import re
import sys
from pathlib import Path

PLACEHOLDER = "  releaseImageDigests: {}\n"
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?")
NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def main(values_path):
    version = os.environ["VERSION"]
    if not VERSION.fullmatch(version):
        raise ValueError(f"Invalid version {version!r}")
    images = json.loads(os.environ["DIGESTS"])
    if not isinstance(images, dict) or "mcp-server-base" not in images:
        raise ValueError("DIGESTS must map image names to digests and include mcp-server-base")
    for name, digest in images.items():
        if not NAME.fullmatch(name) or not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ValueError(f"Invalid digest entry for {name!r}")
    path = Path(values_path)
    values = path.read_text()
    if values.count(PLACEHOLDER) != 1:
        raise ValueError(f"{path} must contain exactly one {PLACEHOLDER.strip()!r} line")
    # JSON is valid YAML flow syntax, so the line stays one mapping.
    pinned = json.dumps({"version": version, "images": dict(sorted(images.items()))})
    path.write_text(values.replace(PLACEHOLDER, f"  releaseImageDigests: {pinned}\n"))
    print(f"Pinned {len(images)} release images for {version}")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        sys.exit(f"Cannot pin release image digests: {error}")
