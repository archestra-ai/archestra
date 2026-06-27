"""Verify the agent authored a skill AND triggered its bundled script to produce the answer.

Reads BENCH_STATE (the harness snapshot): `rest` holds the `/api/skills?search=...` response captured
after the run, and `tool_calls` holds the run's ordered tool invocations ({name, input}). The skill's
existence is backend state (not something the agent submits), and a run_command that referenced the
mounted `/skills/<name>` path proves the bundled script actually ran -- not merely that the skill was
created or mounted. BENCH_RESULT carries the submitted prime count.
"""

from bench_verifier import result, state

_PRIMES_LE_100000 = 9592  # π(100000), a fixed mathematical constant


def _created_skill(snapshot: dict) -> dict:
    rest = snapshot["rest"]
    assert len(rest) == 1, f"expected exactly one captured rest path, got {list(rest)}"
    skills = next(iter(rest.values()))
    rows = skills.get("data") if isinstance(skills, dict) else None
    assert isinstance(rows, list) and len(rows) == 1, f"expected exactly one matching skill, got {rows}"
    skill = rows[0]
    assert skill.get("sourceType") == "manual", f"skill is not agent-authored: sourceType={skill.get('sourceType')!r}"
    assert skill.get("fileCount", 0) >= 2, f"skill bundles no file (SKILL.md only): fileCount={skill.get('fileCount')!r}"
    return skill


def _run_command_text(call: dict) -> str:
    """The text of a run_command invocation: its `command` plus its `cwd`. The mounted skill path may
    appear in either -- the documented pattern runs a bundled script with `cwd: /skills/<name>` and a
    relative command, but an absolute `python /skills/<name>/...` command is equally valid."""
    inp = call.get("input") or {}
    return " ".join(str(inp.get(field) or "") for field in ("command", "cwd"))


def test_skill_created_and_script_ran() -> None:
    snapshot = state()
    skill = _created_skill(snapshot)
    mount = f"/skills/{skill['name']}"
    ran = [
        call
        for call in snapshot.get("tool_calls", [])
        if call.get("name") == "archestra__run_command"
        and mount in (text := _run_command_text(call))
        and "count.py" in text  # the mounted bundle was *executed*, not merely listed/inspected
    ]
    assert ran, f"no run_command executed the bundled count.py under {mount!r}; the skill was not triggered"


def test_prime_count_correct() -> None:
    submitted = result()
    assert submitted["prime_count"] == _PRIMES_LE_100000, (
        f"submitted prime_count {submitted['prime_count']} != π(100000) = {_PRIMES_LE_100000}"
    )
