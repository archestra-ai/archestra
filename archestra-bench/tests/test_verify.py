"""run_verifier staging: BENCH_RESULT always, BENCH_FIXTURES from disk, BENCH_OUTPUT when produced.

Real I/O end to end: a tiny verifier file asserts the env contract, run under the current
interpreter (no deps), so a green outcome proves the harness staged everything correctly.
"""

from __future__ import annotations

import json
from pathlib import Path

from tasks import Task, Verifier
from verify import run_verifier


def _task(
    tmp_path: Path, verifier_src: str, *, inputs: bool = False, expected: bool = False, deps: tuple[str, ...] = ()
) -> Task:
    d = tmp_path / "t"
    d.mkdir()
    (d / "verifier.py").write_text(verifier_src, encoding="utf-8")
    if inputs:
        (d / "inputs").mkdir()
        (d / "inputs" / "in.txt").write_text("INPUT", encoding="utf-8")
    if expected:
        (d / "expected").mkdir()
        (d / "expected" / "truth.txt").write_text("TRUTH", encoding="utf-8")
    return Task(id="t", dir=d, stages=(), result_schema={}, verifier=Verifier(deps=deps))


def test_result_and_fixtures_staged(tmp_path: Path) -> None:
    verifier = """
import os
def test_env():
    assert open(os.environ["BENCH_RESULT"]).read() == '{"a": 1}'
    fx = os.environ["BENCH_FIXTURES"]
    assert open(os.path.join(fx, "inputs", "in.txt")).read() == "INPUT"
    assert open(os.path.join(fx, "expected", "truth.txt")).read() == "TRUTH"
    assert "BENCH_OUTPUT" not in os.environ
"""
    outcome = run_verifier(_task(tmp_path, verifier, inputs=True, expected=True), b'{"a": 1}')
    assert outcome.passed, outcome.stdout


def test_no_fixtures_means_no_fixtures_env(tmp_path: Path) -> None:
    verifier = """
import os
def test_env():
    assert "BENCH_FIXTURES" not in os.environ
"""
    outcome = run_verifier(_task(tmp_path, verifier), b"{}")
    assert outcome.passed, outcome.stdout


def test_artifact_bytes_staged_byte_exact(tmp_path: Path) -> None:
    verifier = """
import os
def test_output():
    with open(os.environ["BENCH_OUTPUT"], "rb") as f:
        assert f.read() == bytes(range(256))
"""
    outcome = run_verifier(_task(tmp_path, verifier), b"{}", artifact_bytes=bytes(range(256)))
    assert outcome.passed, outcome.stdout


def test_state_bytes_staged_and_readable(tmp_path: Path) -> None:
    verifier = """
import json, os
def test_state():
    state = json.load(open(os.environ["BENCH_STATE"]))
    assert state["rest"]["/api/skills"]["data"] == [{"name": "x"}]
    assert state["tool_calls"] == [{"name": "archestra__run_command", "input": {"command": "ls"}}]
"""
    state = json.dumps(
        {
            "rest": {"/api/skills": {"data": [{"name": "x"}]}},
            "tool_calls": [{"name": "archestra__run_command", "input": {"command": "ls"}}],
        }
    ).encode("utf-8")
    outcome = run_verifier(_task(tmp_path, verifier), b"{}", state_bytes=state)
    assert outcome.passed, outcome.stdout


def test_no_state_means_no_state_env(tmp_path: Path) -> None:
    verifier = """
import os
def test_env():
    assert "BENCH_STATE" not in os.environ
"""
    outcome = run_verifier(_task(tmp_path, verifier), b"{}")
    assert outcome.passed, outcome.stdout


def test_failing_verifier_reports_failure(tmp_path: Path) -> None:
    outcome = run_verifier(_task(tmp_path, "def test_no():\n    assert False\n"), b"{}")
    assert not outcome.passed
    assert outcome.exit_code != 0


def test_dep_verifier_env_has_pytest_and_dep(tmp_path: Path) -> None:
    """A task declaring deps gets an isolated uv env that still has pytest (the harness's runner)
    plus the declared dep -- exercises _build_uv_env, not just the current-interpreter path."""
    verifier = "import openpyxl\ndef test_dep():\n    assert openpyxl.__version__\n"
    outcome = run_verifier(_task(tmp_path, verifier, deps=("openpyxl==3.1.5",)), b"{}")
    assert outcome.passed, outcome.stderr or outcome.stdout
