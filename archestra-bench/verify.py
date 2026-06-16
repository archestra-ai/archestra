# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""harness-side verification: run a task's verifier OUT of the sandbox.

the agent's submission (and, for file-producing tasks, a downloaded artifact) is verified here, in
an isolated temp dir, by the task's pytest verifier running in an ephemeral uv environment. the
verifier assets never enter the sandbox, so the agent cannot read or game them.

the verifier reads (fixed env names, same for every task):
  - BENCH_RESULT   path to the agent's submitted JSON result (always set)
  - BENCH_FIXTURES path to a dir holding the task's `inputs/` and `expected/` (set iff either exists)
  - BENCH_OUTPUT   path to the downloaded agent artifact bytes (set iff the task produces a file)
  - BENCH_STATE    path to a JSON snapshot of backend REST state + the run's tool calls (set iff the
                   task declares `[state].rest`; see run.py for the bundle shape)

failures are loud: if the verifier's dependency environment cannot be built, that is a hard error
(a broken eval host), not a silent task failure.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from tasks import Task

_PYTEST_REQ = "pytest==8.4.1"  # the harness owns the runner; tasks declare only their domain deps
_RESULT_NAME = "result.json"
_OUTPUT_NAME = "artifact.bin"
_STATE_NAME = "state.json"
_FIXTURES_DIR = "fixtures"
_RESULT_ENV = "BENCH_RESULT"  # path to the agent's submitted result
_FIXTURES_ENV = "BENCH_FIXTURES"  # path to the task's inputs/ + expected/ (verifier-only)
_OUTPUT_ENV = "BENCH_OUTPUT"  # path to the agent-produced artifact bytes
_STATE_ENV = "BENCH_STATE"  # path to the backend REST + tool-call snapshot


@dataclass(frozen=True)
class VerifyOutcome:
    passed: bool
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool


def run_verifier(
    task: Task,
    report_bytes: bytes,
    *,
    artifact_bytes: bytes | None = None,
    state_bytes: bytes | None = None,
    timeout_s: float = 900.0,
) -> VerifyOutcome:
    """verify an agent submission (and optional produced artifact / state snapshot) against the task's verifier."""
    with tempfile.TemporaryDirectory(prefix="archestra-bench-verify-") as tmp:
        workdir = Path(tmp)
        python = _resolve_python(task.verifier.deps, workdir)
        test_path, env = _stage(task, workdir, report_bytes, artifact_bytes, state_bytes)
        return _run_pytest(test_path, env=env, python=python, timeout_s=timeout_s)


# === internal ===


def _resolve_python(deps: tuple[str, ...], workdir: Path) -> str:
    """the interpreter to verify with: an ephemeral uv env for tasks with deps, else this one.

    a task with no deps runs under the current interpreter, so a no-dep verifier needs neither uv
    nor network."""
    if not deps:
        return sys.executable
    return _build_uv_env(deps, workdir / ".venv")


def _build_uv_env(deps: tuple[str, ...], venv_dir: Path) -> str:
    """create an isolated uv venv with `deps` installed; return its python path.

    raises (loudly) if uv is missing or dependency resolution fails -- a broken eval host, not
    a task verdict."""
    if shutil.which("uv") is None:
        raise RuntimeError("uv is required to build the verifier environment but was not found")
    create = subprocess.run(["uv", "venv", str(venv_dir)], capture_output=True, text=True)
    if create.returncode != 0:
        raise RuntimeError(f"failed to create verifier venv: {create.stderr.strip()}")
    python = str(venv_dir / "bin" / "python")
    # always install pytest: it is the harness's runner, not a task dependency. tasks declare only
    # their domain libs, so an isolated verifier env still has pytest to launch under.
    install = subprocess.run(
        ["uv", "pip", "install", "--python", python, _PYTEST_REQ, *deps],
        capture_output=True, text=True,
    )
    if install.returncode != 0:
        raise RuntimeError(f"failed to install verifier deps {deps}: {install.stderr.strip()}")
    return python


def _stage(
    task: Task, workdir: Path, report_bytes: bytes, artifact_bytes: bytes | None, state_bytes: bytes | None
) -> tuple[Path, dict[str, str]]:
    """write the submission (+ optional artifact/state), copy fixtures and the verifier file; build env."""
    env: dict[str, str] = {**task.verifier.env}

    result_path = workdir / _RESULT_NAME
    result_path.write_bytes(report_bytes)
    env[_RESULT_ENV] = str(result_path)

    fixtures_root = workdir / _FIXTURES_DIR
    staged_any = False
    for sub, source in (("inputs", task.inputs_dir), ("expected", task.expected_dir)):
        if source.is_dir():
            shutil.copytree(source, fixtures_root / sub)
            staged_any = True
    if staged_any:
        env[_FIXTURES_ENV] = str(fixtures_root)

    if artifact_bytes is not None:
        output_path = workdir / _OUTPUT_NAME
        output_path.write_bytes(artifact_bytes)
        env[_OUTPUT_ENV] = str(output_path)

    if state_bytes is not None:
        state_path = workdir / _STATE_NAME
        state_path.write_bytes(state_bytes)
        env[_STATE_ENV] = str(state_path)

    test_path = workdir / Path(task.verifier.test_file).name
    shutil.copyfile(task.dir / task.verifier.test_file, test_path)
    return test_path, env


def _run_pytest(test_path: Path, *, env: dict[str, str], python: str, timeout_s: float) -> VerifyOutcome:
    """run pytest on a single file; exit 0 is a pass, any nonzero is a fail."""
    # drop host vars that would let the surrounding environment change verifier behavior: the
    # import path and any injected pytest/coverage state. keeps the verdict reproducible.
    full_env = {
        k: v
        for k, v in os.environ.items()
        if k != "PYTHONPATH" and not k.startswith(("PYTEST", "COVERAGE"))
    }
    full_env.update(env)
    try:
        proc = subprocess.run(
            [python, "-m", "pytest", str(test_path), "-rA"],
            cwd=str(test_path.parent), env=full_env,
            capture_output=True, text=True, timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        return VerifyOutcome(
            passed=False, exit_code=-1,
            stdout=_coerce_text(exc.stdout), stderr=_coerce_text(exc.stderr), timed_out=True,
        )
    return VerifyOutcome(
        passed=proc.returncode == 0, exit_code=proc.returncode,
        stdout=proc.stdout, stderr=proc.stderr, timed_out=False,
    )


def _coerce_text(value: str | bytes | None) -> str:
    """captured output may be str (text=True) or bytes; normalize for VerifyOutcome."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
