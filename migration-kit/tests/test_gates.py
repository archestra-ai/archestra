"""enforce the type and lint gates from within the suite.

run via `uv run --group dev pytest` so `ty` and `ruff` are present. a bare `pytest` without
the dev group skips these (the logic tests still run); CI uses the dev group, so the gates
are enforced there, not merely aspirational.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _run(tool: str, *args: str) -> subprocess.CompletedProcess[str]:
    if shutil.which(tool) is None:
        pytest.skip(f"{tool} not installed; run via `uv run --group dev pytest` to enforce this gate")
    return subprocess.run([tool, *args], cwd=ROOT, capture_output=True, text=True)


def test_ty_typecheck_passes() -> None:
    result = _run("ty", "check")
    assert result.returncode == 0, f"ty failed:\n{result.stdout}\n{result.stderr}"


def test_ruff_lint_passes() -> None:
    result = _run("ruff", "check")
    assert result.returncode == 0, f"ruff failed:\n{result.stdout}\n{result.stderr}"
