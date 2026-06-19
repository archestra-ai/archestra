"""Verify the agent decoded the cipher by running the bundled skill script.

The plaintext is bespoke-cipher output, recoverable only via the seeded `cipher-decoder` skill, so an
exact match against the never-staged ground truth (BENCH_FIXTURES/expected/plaintext.txt) is the real
gate. We additionally require, from BENCH_STATE, that the skill was seeded from the repo and that a
run_command actually invoked the mounted decode.pl on the ciphertext -- a bare `cat`/`echo` of the
path, or the path without the ciphertext argument, does not count.
"""

import json
import os
import shlex
from pathlib import Path

MOUNT = "/skills/cipher-decoder"
SCRIPT = "decode.pl"


def _load_json(env_var: str) -> dict:
    path = os.environ.get(env_var)
    assert path, f"{env_var} is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fixture_text(relpath: str) -> str:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    return Path(base, relpath).read_text(encoding="utf-8")


def _ran_decoder_on_ciphertext(call: dict, ciphertext: str) -> bool:
    if call.get("name") != "archestra__run_command":
        return False
    inp = call.get("input") or {}
    try:
        argv = shlex.split(str(inp.get("command") or ""))
    except ValueError:
        return False
    if not argv or os.path.basename(argv[0]) != "perl":
        return False
    scripts = [a for a in argv[1:] if os.path.basename(a) == SCRIPT]
    if not scripts:
        return False
    script = scripts[0]
    cwd = str(inp.get("cwd") or "")
    mounted = script.startswith(MOUNT) or (not script.startswith("/") and MOUNT in cwd)
    # the ciphertext must be a real argv token (passed to the script), not merely echoed in the text
    return mounted and ciphertext in argv


def test_plaintext_matches() -> None:
    expected = _fixture_text("expected/plaintext.txt")
    submitted = _load_json("BENCH_RESULT")["plaintext"]
    assert submitted == expected, f"submitted plaintext {submitted!r} != expected {expected!r}"


def test_skill_loaded() -> None:
    calls = _load_json("BENCH_STATE").get("tool_calls", [])
    loaded = [
        c for c in calls
        if c.get("name") == "archestra__load_skill" and "cipher-decoder" in json.dumps(c.get("input") or {})
    ]
    assert loaded, "no load_skill call for cipher-decoder; the skill was not loaded"


def test_decoder_script_ran_on_ciphertext() -> None:
    state = _load_json("BENCH_STATE")
    ciphertext = _fixture_text("inputs/cipher.txt").strip()
    ran = [c for c in state.get("tool_calls", []) if _ran_decoder_on_ciphertext(c, ciphertext)]
    assert ran, (
        f"no run_command invoked `perl {MOUNT}/.../{SCRIPT} <ciphertext>` with the ciphertext as an "
        "argument; the bundled decoder was not executed on the blob"
    )


def test_skill_seeded_from_repo() -> None:
    state = _load_json("BENCH_STATE")
    rest = state["rest"]
    assert len(rest) == 1, f"expected exactly one captured rest path, got {list(rest)}"
    payload = next(iter(rest.values()))
    rows = payload.get("data") if isinstance(payload, dict) else None
    matches = [r for r in (rows or []) if r.get("name") == "cipher-decoder"]
    assert len(matches) == 1, f"expected exactly one cipher-decoder skill row, got {matches}"
    assert matches[0].get("sourceType") == "github", (
        f"cipher-decoder must be seeded from the repo (sourceType=github), "
        f"got {matches[0].get('sourceType')!r}"
    )
