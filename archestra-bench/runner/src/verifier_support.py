"""Shared IO helpers for bench verifiers.

The harness stages this module next to each task's verifier.py and runs pytest from that directory, so
a verifier imports it directly: `from bench_verifier import result, fixtures`.

Each function does one thing: resolve a BENCH_* env var to a file and parse it. Navigating the parsed
structure -- key lookups, REST envelope unwrapping, tool-call filtering -- stays in the verifier,
because that is task logic, not the contract.
"""

import json
import os
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
