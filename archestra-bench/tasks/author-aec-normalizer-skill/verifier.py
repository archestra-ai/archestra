"""Verify the agent authored ONE reusable normalizer, UPDATED it for the second vendor shape, and ran
the bundled script on both files to produce the submitted rows.

Reads BENCH_STATE (the harness snapshot): `rest` holds the `/api/skills?search=...` response captured
after the run, and `tool_calls` holds the run's ordered tool invocations ({name, input}). The skill's
existence and version are backend state: exactly one matching manual skill that bundles a script and
has advanced past its initial version proves it was created and then updated IN PLACE (a recreate
would surface as a second row or a never-advanced version -- a hard fail). A run_command under the
mounted `/skills/<name>` path that invokes the bundled `normalize.py` against each vendor file proves
the script actually ran on both inputs. BENCH_RESULT carries the submitted normalized rows.

Limitation (accepted, matches author-skill): BENCH_STATE captures tool-call inputs but not their
stdout, so the verifier cannot bind the script's output to the submitted rows -- it proves the script
ran and grades the rows independently. Tightening that would require the harness to capture command
output, which is out of scope here.
"""

from bench_verifier import read_fixture_json, result, state


def _normalize_v2(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        out.append(
            {
                "material_name": r["materialName"].strip(),
                "quantity": int(r["quantity"].replace(",", "")),
                "unit_cost_cents": round(r["unitPrice"] * 100),
                "level": r["location"]["floor"].upper(),
            }
        )
    return out


def _normalizer_skill(snapshot: dict) -> dict:
    rest = snapshot["rest"]
    assert len(rest) == 1, f"expected exactly one captured rest path, got {list(rest)}"
    skills = next(iter(rest.values()))
    rows = skills.get("data") if isinstance(skills, dict) else None
    assert isinstance(rows, list) and len(rows) == 1, (
        f"expected exactly one matching skill (a second skill means recreate, not update), got {rows}"
    )
    skill = rows[0]
    assert skill.get("sourceType") == "manual", f"skill is not agent-authored: sourceType={skill.get('sourceType')!r}"
    assert skill.get("fileCount", 0) >= 2, f"skill bundles no script file (SKILL.md only): fileCount={skill.get('fileCount')!r}"
    return skill


def _effective(call: dict) -> tuple[str | None, dict]:
    """The real tool + args behind a call. Under tool_exposure_mode=search_and_run_only the agent
    invokes discovered tools through the `archestra__run_tool` meta-tool, so a create_skill /
    update_skill / run_command shows up as run_tool with the true tool in input.tool_name and its
    payload in input.tool_args. Unwrap that; pass other calls through unchanged."""
    name = call.get("name")
    inp = call.get("input") or {}
    if name == "archestra__run_tool":
        return inp.get("tool_name"), (inp.get("tool_args") or {})
    return name, inp


def _run_command_text(call: dict) -> str:
    """The text of a (possibly run_tool-wrapped) run_command: its `command` plus its `cwd`. The mounted
    skill path may appear in either -- `cwd: /skills/<name>` with a relative command, or an absolute
    `python /skills/<name>/...` command -- so join both before matching."""
    eff_name, inp = _effective(call)
    if eff_name != "archestra__run_command":
        return ""
    return " ".join(str(inp.get(field) or "") for field in ("command", "cwd"))


def test_expected_matches_recompute() -> None:
    # Sync guard: the committed verifier-only ground truth must agree with the inline recompute, so a
    # generator change or hand-edit to vendor_v2.json can't silently drift the oracle.
    assert read_fixture_json("expected", "normalized_v2.json") == _normalize_v2(
        read_fixture_json("inputs", "vendor_v2.json")
    ), "expected/normalized_v2.json disagrees with the recompute from inputs/vendor_v2.json; fixtures out of sync"


def test_output_rows_match() -> None:
    expected = _normalize_v2(read_fixture_json("inputs", "vendor_v2.json"))
    submitted = result()["rows"]
    assert submitted == expected, f"normalized rows mismatch:\nexpected={expected}\nsubmitted={submitted}"


def test_skill_created_updated_and_used() -> None:
    # Evidence comes from the backend `rest` snapshot, not from tool-call names: exactly one manual
    # skill bundling a script (created), advanced past its initial version (updated IN PLACE -- a
    # recreate would surface as a second row or a never-advanced version), and a run_command that
    # invoked the bundled `normalize.py` under its mount on each vendor file (the bundled script was
    # actually run, not bypassed by a hand-rolled one). Robust to whether create/update/run were called
    # directly or via run_tool.
    snapshot = state()
    skill = _normalizer_skill(snapshot)
    name = skill["name"]
    mount = f"/skills/{name}"

    assert int(skill.get("latestVersion", 1)) >= 2, (
        f"skill {name!r} is still at version {skill.get('latestVersion')!r}; it was created but never "
        "updated in place for the second vendor shape"
    )

    # run_command texts that ran the bundled normalize.py under the skill mount.
    ran = [t for c in snapshot.get("tool_calls", []) if mount in (t := _run_command_text(c)) and "normalize.py" in t]
    assert any("vendor_v1.json" in t for t in ran), (
        f"no run_command invoked {mount!r}'s normalize.py on vendor_v1.json; the bundled script was not run on the first file"
    )
    assert any("vendor_v2.json" in t for t in ran), (
        f"no run_command invoked {mount!r}'s normalize.py on vendor_v2.json; the submitted rows were not produced by the bundled script"
    )
