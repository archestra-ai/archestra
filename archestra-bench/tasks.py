# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Self-contained benchmark task model + loader.

A task lives in its own directory:

    tasks/<id>/task.toml     declarative definition (stages, result schema, verifier, artifact)
    tasks/<id>/verifier.py   pytest verifier, run out of band against the submission
    tasks/<id>/inputs/       files staged into the agent's sandbox (also readable by the verifier)
    tasks/<id>/expected/     verifier-only ground truth; NEVER staged to the agent

A task is an ordered list of conversation **stages** (a "user asks X" turn, then optional "user
corrects to Y" turns). The agent solves it with whatever tools/skills its environment provides and
hands in its answer by calling the benchmark MCP's `submit_result` tool -- so a task declares the
JSON-schema that answer must match (`result_schema`).

A task whose deliverable is a *file* (not a JSON value) sets `artifact_key`: the result property
naming the file the agent exported via `download_file`. The harness downloads that artifact and
hands its bytes to the verifier as `BENCH_OUTPUT` (see run.py / verify.py).

The verifier assets are never staged anywhere the agent can reach. Staged files are confined to
`inputs/` at load time, so a precomputed answer in `expected/` can never leak to the agent.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

import tomlconf

_FILE_PLACEHOLDER = re.compile(r"\{\{file:([^}]+)\}\}")


@dataclass(frozen=True)
class StagedFile:
    """an input file the agent is allowed to see, delivered as a chat file-part on its stage.

    `src` is a relative path under the task's `inputs/` dir; `dest` is the absolute sandbox path it
    auto-stages to (the stage message references it)."""

    src: str
    dest: str
    mime_type: str = "application/octet-stream"


@dataclass(frozen=True)
class Stage:
    """one user turn: `text` is the message, `files` are delivered with it as chat file-parts.

    Later stages model the user changing or refining their ask within the same conversation."""

    text: str
    files: tuple[StagedFile, ...] = ()


@dataclass(frozen=True)
class Verifier:
    """how the harness verifies the submission, OUT of band (never staged where the agent can reach).

    The verifier runs as a pytest file in an ephemeral uv env. It reads the submission from
    `BENCH_RESULT`, optional fixtures from `BENCH_FIXTURES` (a dir with `inputs/` and `expected/`
    subdirectories), and an optional downloaded artifact from `BENCH_OUTPUT` (see verify.py)."""

    deps: tuple[str, ...] = ()  # pip-style requirements for the ephemeral uv env
    test_file: str = "verifier.py"  # pytest file, relative to the task dir
    env: dict[str, str] = field(default_factory=dict)  # extra env (time limits, etc.)


@dataclass(frozen=True)
class Task:
    """declarative description of one benchmark task, loaded from `tasks/<id>/task.toml`."""

    id: str
    dir: Path  # absolute path to the task's directory
    stages: tuple[Stage, ...]
    result_schema: dict[str, Any]  # JSON-schema the submitted result must match
    verifier: Verifier
    artifact_key: str | None = None  # result property naming the produced artifact filename
    max_format_attempts: int = 3  # submit_result self-correction budget
    state_rest: tuple[str, ...] = ()  # backend REST GET paths to snapshot into BENCH_STATE

    @property
    def inputs_dir(self) -> Path:
        return self.dir / "inputs"

    @property
    def expected_dir(self) -> Path:
        return self.dir / "expected"


_DEFAULT_MAX_FORMAT_ATTEMPTS = 3


def load_task(task_dir: Path) -> Task:
    """Parse `task_dir/task.toml` into a Task; validate loudly (id, schema, staged-file confinement)."""
    task_id = task_dir.name
    ctx = f"task {task_id!r}"
    if not tomlconf.is_slug(task_id):
        raise SystemExit(f"{ctx}: task dir name must be lowercase alphanumeric with dashes (slug-safe)")
    toml_path = task_dir / "task.toml"
    if not toml_path.is_file():
        raise SystemExit(f"{ctx}: missing {toml_path}")
    data = tomlconf.parse_toml(toml_path)

    stage_rows = tomlconf.rows(data, "stages", ctx)
    if not stage_rows:
        raise SystemExit(f"{ctx}: task declares no stages")
    stages = tuple(_stage(row, ctx, task_dir) for row in stage_rows)

    schema = tomlconf.table(data, "result_schema", ctx)
    if not isinstance(schema, dict):
        raise SystemExit(f"{ctx}: result_schema must be a table")

    max_attempts = tomlconf.req_int(data, "max_format_attempts", ctx, default=_DEFAULT_MAX_FORMAT_ATTEMPTS)
    if max_attempts < 1:
        raise SystemExit(f"{ctx}: max_format_attempts must be >= 1, got {max_attempts}")

    verifier = _verifier(tomlconf.table(data, "verifier", ctx, default={}), f"{ctx} [verifier]", task_dir)
    state = tomlconf.table(data, "state", ctx, default={})
    state_rest = tuple(_state_path(p, f"{ctx} [state]") for p in tomlconf.strs(state, "rest", f"{ctx} [state]"))

    return Task(
        id=task_id,
        dir=task_dir,
        stages=stages,
        result_schema=dict(schema),
        verifier=verifier,
        artifact_key=tomlconf.opt_str(data, "artifact_key", ctx),
        max_format_attempts=max_attempts,
        state_rest=state_rest,
    )


def _state_path(path: str, ctx: str) -> str:
    """A state-capture entry must be a relative backend API path the harness GETs after the run.

    Reject anything that could escape the backend or the API surface: an absolute URL (scheme/host),
    a path outside `/api/`, or a `..` traversal. Query strings and the runtime `{{cell}}`/`{{agent_id}}`
    placeholders are allowed -- they're substituted at capture time (see run.py)."""
    parts = urlsplit(path)
    if parts.scheme or parts.netloc:
        raise SystemExit(f"{ctx}: rest path {path!r} must be a relative /api/ path, not an absolute URL")
    if not parts.path.startswith("/api/"):
        raise SystemExit(f"{ctx}: rest path {path!r} must start with /api/")
    if ".." in unquote(parts.path).split("/"):  # unquote first: reject `/api/../x` and `/api/%2e%2e/x`
        raise SystemExit(f"{ctx}: rest path {path!r} must not contain a '..' segment")
    return path


def _stage(row: Mapping[str, Any], ctx: str, task_dir: Path) -> Stage:
    text = _expand_files(tomlconf.req_str(row, "text", ctx), task_dir, ctx)
    files = tuple(_staged_file(f, ctx, task_dir / "inputs") for f in tomlconf.rows(row, "files", ctx))
    return Stage(text=text, files=files)


def _expand_files(text: str, task_dir: Path, ctx: str) -> str:
    """Expand `{{file:<relpath>}}` placeholders with the referenced file's text content.

    Used to inline a fixture (e.g. a CSV) into the prompt for providers/tasks that cannot stage a
    file into the sandbox. The path is confined to the task dir so a task can never inline an
    out-of-tree file."""
    base = task_dir.resolve()

    def repl(match: re.Match[str]) -> str:
        rel = match.group(1).strip()
        target = (task_dir / rel).resolve()
        if target != base and base not in target.parents:
            raise SystemExit(f"{ctx}: file placeholder {rel!r} escapes the task dir")
        if not target.is_file():
            raise SystemExit(f"{ctx}: file placeholder {rel!r} does not exist")
        return target.read_text(encoding="utf-8")

    return _FILE_PLACEHOLDER.sub(repl, text)


def _staged_file(row: Mapping[str, Any], ctx: str, inputs_dir: Path) -> StagedFile:
    src = tomlconf.req_str(row, "src", ctx)
    _check_under_inputs(src, inputs_dir, ctx)
    return StagedFile(
        src=src,
        dest=tomlconf.req_str(row, "dest", ctx),
        mime_type=tomlconf.req_str(row, "mime_type", ctx, default="application/octet-stream"),
    )


def _check_under_inputs(src: str, inputs_dir: Path, ctx: str) -> None:
    """A staged source must resolve to an existing file strictly under `inputs/` -- never an
    absolute path or a `..` escape into the verifier-only `expected/` dir or out of the task tree."""
    if PurePosixPath(src).is_absolute() or src.startswith("/"):
        raise SystemExit(f"{ctx}: staged file src {src!r} must be relative (under inputs/)")
    base = inputs_dir.resolve()
    target = (inputs_dir / src).resolve()
    if target != base and base not in target.parents:
        raise SystemExit(f"{ctx}: staged file src {src!r} escapes inputs/")
    if not target.is_file():
        raise SystemExit(f"{ctx}: staged file {inputs_dir / src} does not exist")


def _verifier(tbl: Mapping[str, Any], ctx: str, task_dir: Path) -> Verifier:
    defaults = Verifier()
    test_file = tomlconf.req_str(tbl, "test_file", ctx, default=defaults.test_file)
    if PurePosixPath(test_file).is_absolute() or test_file.startswith("/"):
        raise SystemExit(f"{ctx}: test_file {test_file!r} must be relative (under the task dir)")
    base = task_dir.resolve()
    target = (task_dir / test_file).resolve()
    if target != base and base not in target.parents:
        raise SystemExit(f"{ctx}: test_file {test_file!r} escapes the task dir")
    if not target.is_file():
        raise SystemExit(f"{ctx}: verifier {task_dir / test_file} does not exist")
    return Verifier(
        deps=tuple(tomlconf.strs(tbl, "deps", ctx)),
        test_file=test_file,
        env=tomlconf.str_map(tbl, "env", ctx),
    )
