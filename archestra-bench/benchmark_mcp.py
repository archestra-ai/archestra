"""The harness-owned benchmark MCP server exposing one tool, `submit_result`.

The agent calls `submit_result(result=...)` to hand in its answer. This tool checks only the
*format* of the answer against the task's JSON-schema -- it never evaluates correctness (that
happens out of band in verify.py, against assets the agent can never see). A malformed payload is
not a task failure: the tool returns a structured, actionable error so the model self-corrects
inside its own tool-use loop, bounded by a small attempt budget. The first schema-valid submission
wins and is captured as canonical JSON bytes for the verifier.

The server runs as FastMCP's streamable-http ASGI app under uvicorn in a daemon thread, so the
tool handler shares process memory with the orchestrator and captures submissions with no IPC.
Tasks run strictly serially, so a single per-task context (guarded by one lock) is race-free even
though an MCP connection may carry concurrent tool calls.
"""

from __future__ import annotations

import contextlib
import json
import logging
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any

import uvicorn
from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from jsonschema.protocols import Validator
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

TOOL_NAME = "submit_result"


@dataclass(frozen=True)
class SubmissionAccepted:
    """A schema-valid submission, captured as the exact bytes handed to the verifier."""

    payload_bytes: bytes
    attempts: int


@dataclass(frozen=True)
class SubmissionFormatFailed:
    """The agent submitted but never matched the schema within the attempt budget."""

    attempts: int
    errors: tuple[str, ...]


Submission = SubmissionAccepted | SubmissionFormatFailed | None


@dataclass
class _TaskContext:
    task_key: str
    validator: Validator
    max_attempts: int
    accepting: bool = False  # armed only for the final stage; earlier stages must not lock a result
    attempts: int = 0
    accepted: bytes | None = None
    failed: bool = False
    errors: tuple[str, ...] = ()


class BenchmarkMcp:
    """A FastMCP streamable-http server hosting `submit_result`, controlled by the orchestrator.

    Lifecycle: `with BenchmarkMcp() as mcp:` starts the server on a free port; `begin_task` opens a
    fresh per-task context before driving a conversation; `take_submission` reads the outcome after
    the conversation finishes. Strictly one task at a time."""

    def __init__(self, *, host: str = "127.0.0.1", server_name: str = "benchmark") -> None:
        self._host = host
        self._port = _free_port(host)
        self._lock = threading.Lock()
        self._ctx: _TaskContext | None = None

        self._mcp = FastMCP(server_name, host=host, port=self._port)

        @self._mcp.tool(name=TOOL_NAME)
        def submit_result(result: dict[str, Any]) -> str:
            """Submit your final answer for grading. Pass it as the `result` argument: a single JSON
            object matching the format described in your task instructions. Do not write a file --
            call this tool. If the format is wrong you will get a description of the problem; fix it
            and call this tool again."""
            return self._handle_submit(result)

        config = uvicorn.Config(
            self._mcp.streamable_http_app(),
            host=host,
            port=self._port,
            log_level="warning",
            access_log=False,
        )
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(target=self._server.run, name="benchmark-mcp", daemon=True)

    def __enter__(self) -> "BenchmarkMcp":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    def start(self, *, timeout_s: float = 20.0) -> None:
        self._thread.start()
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._server.started:
                return
            time.sleep(0.05)
        raise TimeoutError("benchmark MCP server did not start in time")

    def stop(self) -> None:
        self._server.should_exit = True
        self._thread.join(timeout=10.0)

    def base_url(self) -> str:
        return f"http://{self._host}:{self._port}/mcp"

    def begin_task(self, *, task_key: str, schema: dict[str, Any], max_attempts: int) -> None:
        """Open a fresh context for the next conversation. Validates the schema itself up front."""
        if max_attempts < 1:
            raise ValueError("max_attempts must be >= 1")
        Draft202012Validator.check_schema(schema)
        with self._lock:
            self._ctx = _TaskContext(
                task_key=task_key, validator=Draft202012Validator(schema), max_attempts=max_attempts
            )

    def allow_submission(self, task_key: str) -> None:
        """Arm the active task to accept a submission -- called before driving its final stage.

        Until armed, `submit_result` is a sequencing error (the agent is mid-task) rather than a real
        answer, so it is refused without consuming the format-correction budget. Single-stage tasks are
        armed before their only stage, so this is a no-op for them."""
        with self._lock:
            if self._ctx is not None and self._ctx.task_key == task_key:
                self._ctx.accepting = True

    def take_submission(self, task_key: str) -> Submission:
        """Read the outcome for `task_key` and close the context (`_ctx = None`).

        The key guards orchestrator/task identity: a wrong-key read returns None, never another task's
        result. Closing means a late submission arriving *between* tasks hits the inactive-task path
        rather than a stale context. A straggler landing *during* the next task's window is still
        recorded by `_handle_submit` -- the tool call carries no task id, so closing that needs
        conversation-scoped tool identity (out of scope here)."""
        with self._lock:
            ctx = self._ctx
            if ctx is None or ctx.task_key != task_key:
                if ctx is not None:
                    logger.warning("take_submission(%r) but active task is %r; ignoring", task_key, ctx.task_key)
                return None
            self._ctx = None
            if ctx.accepted is not None:
                return SubmissionAccepted(payload_bytes=ctx.accepted, attempts=ctx.attempts)
            if ctx.failed:
                return SubmissionFormatFailed(attempts=ctx.attempts, errors=ctx.errors)
            return None

    def _handle_submit(self, result: dict[str, Any]) -> str:
        with self._lock:
            ctx = self._ctx
            if ctx is None:
                return "No benchmark task is active; this submission was ignored."
            if not ctx.accepting:
                return (
                    "This task has more steps to complete. Keep following the instructions and call "
                    "submit_result only when the final step asks you to hand in your answer."
                )
            if ctx.accepted is not None:
                return "A result was already accepted for this task; ignoring this submission."
            if ctx.failed:
                # budget exhaustion is terminal: a later valid submission must not revive the task.
                return "The format-correction budget for this task is exhausted; this submission was ignored."
            ctx.attempts += 1
            errors = _schema_errors(ctx.validator, result)
            if not errors:
                ctx.accepted = _canonical_bytes(result)
                return "Result accepted. The format is valid; you are done."
            if ctx.attempts >= ctx.max_attempts:
                ctx.failed = True
                ctx.errors = errors
                return (
                    f"Result rejected: the format is still invalid after {ctx.attempts} attempts and "
                    "the correction budget is exhausted. Problems:\n" + "\n".join(errors)
                )
            return (
                "Your result does not match the required format. Fix these problems and call "
                "submit_result again:\n" + "\n".join(errors)
            )


def _schema_errors(validator: Validator, result: dict[str, Any]) -> tuple[str, ...]:
    errors = []
    for error in validator.iter_errors(result):
        location = "/".join(str(part) for part in error.absolute_path) or "(root)"
        errors.append(f"- at `{location}`: {_explain(error)}")
    return tuple(sorted(errors))


def _explain(error: ValidationError) -> str:
    """jsonschema's default type message quotes the value (`'84712' is not of type 'number'`), which
    weaker models misread as "the value is already correct". For type mismatches, name the *received*
    JSON type and show the literal, so a model that sent a stringified number sees exactly what to fix."""
    if error.validator != "type":
        return error.message
    expected = error.validator_value
    expected_str = expected if isinstance(expected, str) else " or ".join(expected)
    received = _json_type_name(error.instance)
    return (
        f"expected a JSON {expected_str}, but received a {received}: {json.dumps(error.instance)}. "
        f"Send a bare JSON {expected_str}, not a {received}."
    )


def _json_type_name(value: object) -> str:
    match value:
        case bool():
            return "boolean"
        case int() | float():
            return "number"
        case str():
            return "string"
        case list():
            return "array"
        case dict():
            return "object"
        case None:
            return "null"
        case _:
            return type(value).__name__


def _canonical_bytes(result: dict[str, Any]) -> bytes:
    return json.dumps(result, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")


def _free_port(host: str) -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]
