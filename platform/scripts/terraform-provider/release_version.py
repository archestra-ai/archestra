"""Read an OpenAPI release version in the tag/image version format."""

import json
from pathlib import Path
import re
import sys


def release_version(spec):
    version = json.loads(spec.read_text())["info"]["version"]
    if not isinstance(version, str) or not re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("OpenAPI spec does not name a platform release")
    return version.removeprefix("v")


if __name__ == "__main__":
    print(release_version(Path(sys.argv[1])))
