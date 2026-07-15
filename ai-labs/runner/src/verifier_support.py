"""Shared IO helpers for bench verifiers.

The harness stages this module next to each task's verifier.py and runs pytest from that directory, so
a verifier imports it directly: `from bench_verifier import result, fixtures, tool_calls`.

Each function does one thing: resolve a BENCH_* env var to a file and parse it. Navigating the parsed
structure -- key lookups, REST envelope unwrapping -- stays in the verifier, because that is task
logic, not the contract. The one exception is the `archestra__run_tool` envelope: decoding it is
harness mechanics every task shares, so `tool_calls()` lives here; task-specific matching over the
decoded calls stays in the verifier.
"""

import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any


def _env_path(name: str) -> Path:
    value = os.environ.get(name)
    assert value, f"{name} is not set"
    return Path(value)


def result() -> dict:
    return json.loads(_env_path("BENCH_RESULT").read_text(encoding="utf-8"))


def state() -> dict:
    return json.loads(_env_path("BENCH_STATE").read_text(encoding="utf-8"))


def output() -> Path:
    return _env_path("BENCH_OUTPUT")


def fixtures(*rel: str) -> Path:
    return _env_path("BENCH_FIXTURES").joinpath(*rel)


def read_fixture_json(*rel: str) -> Any:
    return json.loads(fixtures(*rel).read_text(encoding="utf-8"))


def tool_calls() -> Iterator[tuple[str, dict]]:
    """Each tool call in the run's trajectory as (effective_name, input). Under
    tool_exposure_mode=search_and_run_only the agent invokes discovered tools through the
    `archestra__run_tool` meta-tool with input {tool_name, tool_args}; decode that envelope so
    callers see the real tool name + args either way. Args are the raw recorded call -- the
    verifier is a strict oracle and never repairs a wrapper shape, even one the platform repairs
    at dispatch. Entries with a falsy effective name (e.g. a run_tool call missing tool_name) are
    skipped; a non-dict input degrades to {}."""
    for call in state().get("tool_calls", []):
        name = call.get("name")
        inp = call.get("input")
        inp = inp if isinstance(inp, dict) else {}
        if name == "archestra__run_tool":
            name, inp = inp.get("tool_name"), inp.get("tool_args")
            inp = inp if isinstance(inp, dict) else {}
        if name:
            yield name, inp
