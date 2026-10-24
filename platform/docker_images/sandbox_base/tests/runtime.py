"""Qualify the baked sandbox's installers and Python project without egress."""

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

import httpx
import numpy as np
import pandas as pd


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True, stderr=subprocess.STDOUT)


assert os.getuid() == 1000
for tool in ("bash", "cat", "curl", "git", "jq", "cc", "node", "npm", "npx", "unzip", "zip", "uv"):
    assert shutil.which(tool), tool

# The real project interpreter still imports its numerical and HTTP libraries.
assert Path(sys.prefix) == Path("/home/sandbox/.venv")
assert pd.DataFrame({"value": np.arange(3)}).value.sum() == 3
with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, text="ok"))) as client:
    assert client.get("https://sandbox.invalid").text == "ok"

# Both entrypoint and module forms must honor the existing pip-disabled policy.
for tool in ("pip", "pip3", "pip3.14"):
    result = subprocess.run([tool, "--version"], capture_output=True, text=True)
    assert result.returncode == 1 and "uv add --project /home/sandbox" in result.stderr
assert importlib.util.find_spec("pip") is None
result = subprocess.run(["/usr/local/bin/python3", "-m", "pip", "--version"], capture_output=True, text=True)
assert result.returncode != 0 and "No module named pip" in result.stderr

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    # A local wheel proves uv still creates and extends projects without pip or
    # ensurepip. No package is downloaded or install script executed.
    wheel = root / "sandbox_probe-1.0.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("sandbox_probe.py", "VALUE = 42\n")
        archive.writestr("sandbox_probe-1.0.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: sandbox-probe\nVersion: 1.0.0\n")
        archive.writestr("sandbox_probe-1.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\nGenerator: sandbox-runtime-test\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
        archive.writestr("sandbox_probe-1.0.0.dist-info/RECORD", "")
    project = root / "python-project"
    project.mkdir()
    (project / "pyproject.toml").write_text('[project]\nname="sandbox-probe-consumer"\nversion="0.0.0"\nrequires-python=">=3.14"\ndependencies=[]\n')
    run("uv", "add", "--offline", "--project", str(project), str(wheel))
    assert run(str(project / ".venv/bin/python"), "-c", "import sandbox_probe; print(sandbox_probe.VALUE)").strip() == "42"

    # Exercise npm's archive packing, local dependency install and npx command
    # execution using the same unprivileged sandbox user as runtime commands.
    package = root / "npm-package"
    package.mkdir()
    (package / "package.json").write_text(json.dumps({"name": "sandbox-runtime-probe", "version": "1.0.0", "main": "index.js", "bin": {"sandbox-probe": "cli.js"}}))
    (package / "index.js").write_text("module.exports = 42;\n")
    (package / "cli.js").write_text("#!/usr/bin/env node\nconsole.log(require('./index.js'));\n")
    (package / "cli.js").chmod(0o755)
    run("npm", "pack", "--ignore-scripts", "--offline", cwd=package)
    consumer = root / "npm-consumer"
    consumer.mkdir()
    (consumer / "package.json").write_text('{"name":"sandbox-consumer","version":"1.0.0"}')
    run("npm", "install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", str(package / "sandbox-runtime-probe-1.0.0.tgz"), cwd=consumer)
    assert run("node", "-p", "require('sandbox-runtime-probe')", cwd=consumer).strip() == "42"
    assert run("npx", "--offline", "--no", "sandbox-probe", cwd=consumer).strip() == "42"

run("node", str(Path(__file__).with_name("npm-http.cjs")))
print("Sandbox Node/npm/npx, uv project installs, Python imports and pip policy pass")
