# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""harness-side verification: run a task's vendored verifier (and oracle) OUT of the sandbox.

the agent's output is downloaded from the conversation's sandbox and verified here, in an
isolated temp dir, by the upstream pytest verifier running in an ephemeral uv environment. the
verifier and oracle assets never enter the sandbox, so the agent cannot read or game them.

failures are loud: if the verifier's dependency environment cannot be built, that is a hard
error (a broken eval host), not a silent task failure.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from tasks import WORKDIR_TOKEN, TextReplacement, VerifierSpec, apply_replacements

_REPORT_NAME = "report.json"
_DATA_NAME = "data.json"


@dataclass(frozen=True)
class VerifyOutcome:
    passed: bool
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool


def run_verifier(spec: VerifierSpec, upstream_dir: Path, report_bytes: bytes,
                 *, timeout_s: float = 900.0) -> VerifyOutcome:
    """verify an agent-produced report against the task's ground-truth verifier."""
    with tempfile.TemporaryDirectory(prefix="archestra-bench-verify-") as tmp:
        workdir = Path(tmp)
        python = _resolve_python(spec.deps, workdir)
        test_path, env = _stage(spec, upstream_dir, workdir, report_bytes)
        return _run_pytest(test_path, env=env, python=python, timeout_s=timeout_s)


def run_gate(spec: VerifierSpec, upstream_dir: Path, *, timeout_s: float = 900.0) -> VerifyOutcome:
    """fidelity gate: run the task's oracle to produce a known-good report, then verify it.

    proves the task + verifier are sound (a correct solution passes) independent of any agent.
    raises if the task declares no oracle."""
    if spec.oracle_file is None:
        raise ValueError("task has no oracle to run a fidelity gate against")
    with tempfile.TemporaryDirectory(prefix="archestra-bench-gate-") as tmp:
        workdir = Path(tmp)
        python = _resolve_python(spec.deps, workdir)
        report_bytes = _run_oracle(spec, upstream_dir, workdir, python=python, timeout_s=timeout_s)
        test_path, env = _stage(spec, upstream_dir, workdir, report_bytes)
        return _run_pytest(test_path, env=env, python=python, timeout_s=timeout_s)


# === internal ===


def _render_oracle(spec: VerifierSpec, upstream_dir: Path, workdir: Path) -> str:
    """the oracle script with its hardcoded paths remapped onto the gate's working dir."""
    if spec.oracle_file is None:
        raise ValueError("task has no oracle")
    text = (upstream_dir / spec.oracle_file).read_text(encoding="utf-8")
    replacements = tuple(
        TextReplacement(frm=r.frm, to=r.to.replace(WORKDIR_TOKEN, str(workdir)))
        for r in spec.oracle_replacements
    )
    return apply_replacements(text, replacements)


def _resolve_python(deps: tuple[str, ...], workdir: Path) -> str:
    """the interpreter to verify with: an ephemeral uv env for tasks with deps, else this one.

    a task with no deps (e.g. the `basics` env) runs under the current interpreter, so a no-dep
    verifier needs neither uv nor network."""
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
    install = subprocess.run(
        ["uv", "pip", "install", "--python", python, *deps],
        capture_output=True, text=True,
    )
    if install.returncode != 0:
        raise RuntimeError(f"failed to install verifier deps {deps}: {install.stderr.strip()}")
    return python


def _stage(spec: VerifierSpec, upstream_dir: Path, workdir: Path,
           report_bytes: bytes) -> tuple[Path, dict[str, str]]:
    """write the report + copy the data and test files into the isolated workdir; build env."""
    report_path = workdir / _REPORT_NAME
    report_path.write_bytes(report_bytes)
    data_path = workdir / _DATA_NAME
    shutil.copyfile(upstream_dir / spec.data_file, data_path)
    test_path = workdir / Path(spec.test_file).name
    shutil.copyfile(upstream_dir / spec.test_file, test_path)
    env = {
        spec.report_env: str(report_path),
        spec.data_env: str(data_path),
        **spec.env,
    }
    return test_path, env


def _run_pytest(test_path: Path, *, env: dict[str, str], python: str,
                timeout_s: float) -> VerifyOutcome:
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


def _run_oracle(spec: VerifierSpec, upstream_dir: Path, workdir: Path, *,
                python: str, timeout_s: float) -> bytes:
    """run the remapped oracle to produce report.json in the gate workdir; return its bytes."""

    shutil.copyfile(upstream_dir / spec.data_file, workdir / _DATA_NAME)
    script = _render_oracle(spec, upstream_dir, workdir)
    script_path = workdir / "oracle.sh"
    script_path.write_text(script, encoding="utf-8")
    proc = subprocess.run(
        ["bash", str(script_path)],
        cwd=str(workdir), env={**os.environ, "PATH": _python_path_env(python)},
        capture_output=True, text=True, timeout=timeout_s,
    )
    report_path = workdir / _REPORT_NAME
    if proc.returncode != 0 or not report_path.exists():
        raise RuntimeError(
            f"oracle did not produce {_REPORT_NAME} (exit {proc.returncode}): {proc.stderr.strip()}"
        )
    return report_path.read_bytes()


def _python_path_env(python: str) -> str:
    """prepend the verifier interpreter's dir to PATH so the oracle's `python3` resolves to it."""
    return f"{Path(python).parent}{os.pathsep}{os.environ.get('PATH', '')}"


def _coerce_text(value: str | bytes | None) -> str:
    """captured output may be str (text=True) or bytes; normalize for VerifyOutcome."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value
