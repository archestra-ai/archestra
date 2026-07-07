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


def _envelope_inner(value: Any) -> tuple[bool, Any]:
    """The candidate inner value of a wrapper shape the platform repairs: any
    single-key dict (the key name carries no meaning), or the exact two-key
    Anthropic content block {"type": "text", "text": X}. Mirrors
    envelopeInnerValue in the platform's run-tool.ts."""
    if not isinstance(value, dict):
        return False, None
    if len(value) == 1:
        ((_, inner),) = value.items()
        return True, inner
    if len(value) == 2 and value.get("type") == "text" and "text" in value:
        return True, value["text"]
    return False, None


def _unwrap_value_envelopes(args: dict) -> dict:
    """Shallow-unwrap the wrapper shapes the platform repairs at dispatch, e.g.
    {"appId": {"value": "x"}}, {"appId": {"appId": "x"}}, or
    {"name": {"type": "text", "text": "x"}} -> the inner value. Only a scalar or
    list inner value is unwrapped, approximating the platform's declared-type
    guard, which this schema-free layer cannot see. Never recurses; a dict-valued
    inner payload is never unwrapped."""
    out: dict = {}
    for k, v in args.items():
        found, inner = _envelope_inner(v)
        if found and isinstance(inner, (str, int, float, bool, list)):
            v = inner
        out[k] = v
    return out


def tool_calls() -> Iterator[tuple[str, dict]]:
    """Each tool call in the run's trajectory as (effective_name, input). Under
    tool_exposure_mode=search_and_run_only the agent invokes discovered tools through the
    `archestra__run_tool` meta-tool with input {tool_name, tool_args}; decode that envelope so
    callers see the real tool name + args either way. run_tool args are then shallow-normalized,
    approximating the platform's dispatch-time repair (which exists only on the run_tool path — a
    direct call keeps its raw args, exactly as the platform saw them): a value that is any
    single-key dict, or the {"type": "text", "text": X} content block,
    holding a scalar or list, is replaced by that inner value -- the platform repairs such
    envelopes at dispatch but records the raw args, so without this the record misrepresents what
    ran. This layer is schema-free and slightly more permissive than the platform (it cannot see
    declared param types), so a normalized entry is still just an attempt, not proof the call
    executed. Dict-valued inner payloads are never unwrapped and there is no recursion. Entries with a
    falsy effective name (e.g. a run_tool call missing tool_name) are skipped; a non-dict input
    degrades to {}."""
    for call in state().get("tool_calls", []):
        name = call.get("name")
        inp = call.get("input")
        inp = inp if isinstance(inp, dict) else {}
        if name == "archestra__run_tool":
            name, inp = inp.get("tool_name"), inp.get("tool_args")
            inp = _unwrap_value_envelopes(inp) if isinstance(inp, dict) else {}
        if name:
            yield name, inp
