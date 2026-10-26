"""Build release metadata from the verified source tag instead of its placeholder.

Keep the root lock entry in sync without resolving any dependency versions.
"""

import sys
import tomllib
from pathlib import Path

root = Path(sys.argv[1])
version = sys.argv[2]
project = root / "pyproject.toml"
lock = root / "uv.lock"
assert tomllib.loads(project.read_text())["project"]["version"] == "0.0.0"
project.write_text(
    project.read_text().replace('version = "0.0.0"', f'version = "{version}"', 1)
)
old = 'name = "hermes-agent"\nversion = "0.0.0"'
assert lock.read_text().count(old) == 1
lock.write_text(
    lock.read_text().replace(old, f'name = "hermes-agent"\nversion = "{version}"', 1)
)
