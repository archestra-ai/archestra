# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""task model + adaptation: turn a benchmark task definition into upload-ready, send-ready pieces.

A task is an ordered list of conversation **stages** (a "user asks X" turn, then optional "user
corrects to Y" turns). The agent solves the task with whatever tools/skills its environment provides
and hands in its answer by calling the benchmark MCP's `submit_result` tool -- so a task also
declares the JSON-schema that answer must match (`result_schema`).

Skills and MCP fixtures are declared at the **environment** level (see envs.py), not per task. A
task may still seed its own MCP fixtures via `mcps`.

The verifier + oracle assets are NOT staged anywhere the agent can reach -- they run in the harness
against the submitted bytes (anti-cheating). `adapt_task` is pure given an UpstreamFs reader.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

# placeholder the oracle's path remap uses for the gate's working dir; verify.py fills it in
# at run time (the oracle hardcodes an absolute root we cannot know until the gate dir exists).
WORKDIR_TOKEN = "{WORKDIR}"


@dataclass(frozen=True)
class TextReplacement:
    """an ordered literal substitution applied to instruction text (path remap, etc.)."""

    frm: str
    to: str


@dataclass(frozen=True)
class StagedFile:
    """an input file the agent is allowed to see, delivered as a chat file-part on its stage.

    `dest` is the sandbox path the file auto-stages to; the stage message references it."""

    upstream: str  # path relative to the task's upstream/ dir
    dest: str  # absolute sandbox path it lands at (under /home/sandbox/attachments)
    mime_type: str = "application/octet-stream"


@dataclass(frozen=True)
class StageSpec:
    """one user turn. The message is `instruction_file` (read + replaced), then `text` appended.

    `files` are delivered with this turn as chat file-parts; later stages model the user changing
    or refining their ask within the same conversation."""

    text: str = ""
    instruction_file: str | None = None  # markdown file relative to upstream/
    files: tuple[StagedFile, ...] = ()
    text_replacements: tuple[TextReplacement, ...] = ()


@dataclass(frozen=True)
class McpFixture:
    """an extra MCP server the agent may use, seeded as a remote catalog item (by URL)."""

    name: str
    server_url: str


@dataclass(frozen=True)
class VerifierSpec:
    """how the harness verifies the agent's submitted result, OUT of band (never staged anywhere
    the agent can reach).

    the verifier and oracle run locally in an ephemeral uv env. the verifier reads the submitted
    result and the task's input data via env knobs the upstream test exposes."""

    deps: tuple[str, ...]  # pip-style requirements for the ephemeral uv env
    test_file: str  # pytest file, relative to upstream/
    data_file: str  # input data, relative to upstream/ (the verifier's ground truth input)
    report_env: str  # env var the test reads the agent's submitted result path from
    data_env: str  # env var the test reads the data path from
    env: dict[str, str] = field(default_factory=dict)  # extra env (time limits, etc.)
    # the oracle reproduces a known-good report for the fidelity gate. it hardcodes upstream
    # paths, so `oracle_replacements` remaps them onto the gate's working dir at run time.
    oracle_file: str | None = None  # oracle script, relative to upstream/
    oracle_replacements: tuple[TextReplacement, ...] = ()


@dataclass(frozen=True)
class TaskConfig:
    """declarative description of one benchmark task."""

    id: str
    upstream_dir: Path  # absolute path to the task's upstream/ dir
    stages: tuple[StageSpec, ...]
    result_schema: dict[str, Any]  # JSON-schema the submitted result must match
    verifier: VerifierSpec
    mcps: tuple[McpFixture, ...] = ()
    max_format_attempts: int = 3  # submit_result self-correction budget


@dataclass(frozen=True)
class AdaptedFile:
    dest: str
    content: bytes
    mime_type: str

    @property
    def filename(self) -> str:
        return PurePosixPath(self.dest).name


@dataclass(frozen=True)
class AdaptedStage:
    message: str
    files: tuple[AdaptedFile, ...]


@dataclass(frozen=True)
class AdaptedTask:
    id: str
    stages: tuple[AdaptedStage, ...]
    mcps: tuple[McpFixture, ...]
    result_schema: dict[str, Any]
    verifier: VerifierSpec
    max_format_attempts: int


class UpstreamFs(Protocol):
    """read access to a task's vendored upstream/ tree."""

    def read(self, rel_path: str) -> bytes: ...


def apply_replacements(text: str, replacements: tuple[TextReplacement, ...]) -> str:
    """apply ordered literal substitutions; later replacements see earlier output."""
    for r in replacements:
        text = text.replace(r.frm, r.to)
    return text


def adapt_task(config: TaskConfig, fs: UpstreamFs) -> AdaptedTask:
    stages = tuple(_adapt_stage(stage, fs) for stage in config.stages)
    return AdaptedTask(
        id=config.id,
        stages=stages,
        mcps=config.mcps,
        result_schema=config.result_schema,
        verifier=config.verifier,
        max_format_attempts=config.max_format_attempts,
    )


class FsUpstream:
    """filesystem-backed UpstreamFs rooted at a task's vendored upstream/ dir."""

    def __init__(self, upstream_dir: Path) -> None:
        self._root = upstream_dir

    def read(self, rel_path: str) -> bytes:
        return (self._root / rel_path).read_bytes()


def _adapt_stage(stage: StageSpec, fs: UpstreamFs) -> AdaptedStage:
    parts: list[str] = []
    if stage.instruction_file is not None:
        body = apply_replacements(fs.read(stage.instruction_file).decode("utf-8"), stage.text_replacements)
        parts.append(body)
    if stage.text:
        parts.append(apply_replacements(stage.text, stage.text_replacements))
    message = "\n\n".join(parts)
    files = tuple(
        AdaptedFile(dest=f.dest, content=fs.read(f.upstream), mime_type=f.mime_type) for f in stage.files
    )
    return AdaptedStage(message=message, files=files)
