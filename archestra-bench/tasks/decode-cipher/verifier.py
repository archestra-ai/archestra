"""Verify the agent decoded the cipher by recovering the bespoke plaintext.

The plaintext is bespoke-cipher output, recoverable only by running the ciphertext through the
seeded `cipher-decoder` skill, so an exact match against the never-staged ground truth
(BENCH_FIXTURES/expected/plaintext.txt) is the real gate. We additionally require, from
BENCH_STATE, that the skill was loaded and seeded from the repo -- robust signals that the agent
engaged the skill and that the bench provisioned it correctly.
"""

import json

from bench_verifier import fixtures, result, state


def test_plaintext_matches() -> None:
    expected = fixtures("expected/plaintext.txt").read_text(encoding="utf-8")
    submitted = result()["plaintext"]
    assert submitted == expected, f"submitted plaintext {submitted!r} != expected {expected!r}"


def test_skill_loaded() -> None:
    calls = state().get("tool_calls", [])
    loaded = [
        c for c in calls
        if c.get("name") == "archestra__load_skill" and "cipher-decoder" in json.dumps(c.get("input") or {})
    ]
    assert loaded, "no load_skill call for cipher-decoder; the skill was not loaded"


def test_skill_seeded_from_repo() -> None:
    rest = state()["rest"]
    assert len(rest) == 1, f"expected exactly one captured rest path, got {list(rest)}"
    payload = next(iter(rest.values()))
    rows = payload.get("data") if isinstance(payload, dict) else None
    matches = [r for r in (rows or []) if r.get("name") == "cipher-decoder"]
    assert len(matches) == 1, f"expected exactly one cipher-decoder skill row, got {matches}"
    assert matches[0].get("sourceType") == "github", (
        f"cipher-decoder must be seeded from the repo (sourceType=github), "
        f"got {matches[0].get('sourceType')!r}"
    )
