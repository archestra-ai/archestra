---
name: migrate-to-archestra
description: Migrate an existing agentic PoC/pilot (Claude Code project files, MCP configs, hooks, local tools, openclaw config, or similar hand-rolled setup artifacts) into an Archestra instance. Use when the user wants to move, port, or convert an existing agentic setup into an Archestra pilot.
license: Apache-2.0
---

# Migrate an agentic PoC to Archestra

You migrate a user's existing agentic PoC or pilot into Archestra. The skill itself runs in Claude
Code, but the source setup may be a messy mix of Claude Code-style files, MCP config, local scripts,
hooks, openclaw config, and other pilot artifacts. The mechanical, deterministic work lives in
bundled Python helpers; you own the product judgment: mapping decisions, asking the user where
ambiguous, getting approval on a preview, and writing the final report.

`$SKILL_DIR` below is the directory containing this file. The helpers are at `$SKILL_DIR/scripts/`.
They are **zero-dependency** and target **Python ≥3.10**, so on a stock interpreter (no `uv`, no
`pip install`, no network) `python3 "$SKILL_DIR/scripts/<x>.py"` just works — important for locked-down
or air-gapped enterprise hosts. `uv run "$SKILL_DIR/scripts/<x>.py"` also works if `uv` is present; the
examples below use `python3` since it needs nothing installed.

The spine — three JSON artifacts, with you applying judgment in the middle:

```
discover.py → inventory.json → [you map + ask the user] → migration_plan.json → apply.py → migration_result.json → [you write report.md]
  deterministic                       judgment                                     deterministic
```

Read `references/entity-mapping.md` before mapping, `references/archestra-api.md` for payload facts,
`references/install.md` for connecting/installing, and `references/report-template.md` before writing
the report. Do them as you reach each step, not all upfront.

## Step 1 — Connect to / install Archestra
Ask whether the user has an existing instance or wants a local docker one. Follow
`references/install.md`. End state: you have a reachable `base_url`, you've called `wait_ready()`,
and you've minted an API key. Export for later steps:
```bash
export ARCHESTRA_BASE_URL=<base_url>
export ARCHESTRA_API_KEY=<minted key>
```
`wait_ready()` is the real gate that you're connected; `GET $ARCHESTRA_BASE_URL/openapi.json` is
also available if you want to sanity-check the API surface.

## Step 2 — Discover the source setup
Ask for the source directory (default: the current working directory). Run:
```bash
python3 "$SKILL_DIR/scripts/discover.py" <source_dir> --out inventory.json
```
This emits a **secret-redacted** inventory (it never writes credentials to the file). Read
`inventory.json`. For items you'll map, skim the relevant bodies. Note anything in `unknowns` — that
includes any frontmatter line the parser refused to interpret (it supports `key: value` scalars,
inline `[a, b]` lists, and `- item` block lists; block scalars `|`/`>`, nested maps, anchors, and
comments are reported here rather than guessed, so read the raw file for those rare cases).

After reading the inventory, summarize it in product terms before mapping:
- likely to migrate cleanly;
- needs user choice or review — including whether to consolidate `tools/*.py` into one toolset
  skill before applying (`entity-mapping.md`, "Local tools");
- report-only/manual follow-up;
- secret redactions or content warnings;
- telemetry/observability (OTEL env, metrics-shipping hooks/scripts) — report-only: Archestra emits
  telemetry natively, so guide the user to leverage that rather than migrating it (`entity-mapping.md`).

## Step 3 — Map and ask
Using `references/entity-mapping.md`, turn the inventory into `migration_plan.json`:
```json
{ "schema_version": 1, "default_scope": "personal",
  "decisions": [ { "source_id": "<inventory id>", "action": "migrate|skip|manual",
                   "target_kind": "agent|skill|mcp_catalog|mcp_install|llm_key|tool_policy",
                   "scope": "personal", "name_override": null, "notes": "...",
                   "user_answers": { } } ] }
```
You author **decisions only** — never raw API payloads; `apply.py` builds and validates those.

Use `AskUserQuestion` only for genuine ambiguities, e.g.:
- the single default scope (`personal`/`team`/`org`), plus any per-item exceptions;
- if any decision uses `team` scope, which concrete Archestra team ids should own it. Put them in
  `user_answers.teamIds`; otherwise use `personal` or `org` scope. Team-scoped agents, skills, and
  MCP catalog items use `teamIds`; team-scoped MCP installs and LLM keys use `teamId` (or the single
  value from `teamIds`). A team-scoped decision with no team id is invalid and `apply.py` will not
  touch the network;
- whether each subagent should be a `skill` (default) or a full `agent`;
- whether to also **install** each MCP server now (`mcp_install`) or just register the catalog item
  (installing a local stdio server spins a K8s pod). If you emit both a `mcp_catalog` and a
  `mcp_install` decision for one server, give them the **same** `name`/`name_override` — the install
  resolves its catalog item by name. `apply.py` attaches installs to the primary migrated agent by
  default; use `user_answers.agentIds` only for extra explicit agent assignments;
- which LLM keys to migrate — and have the user paste each secret into `user_answers.apiKey`
  (with `provider`). Never read a secret out of their files.
- for each `guard` hook, extract its semantics into `user_answers`
  (`tool_name`, `key`, `operator`, `value`, optional `action`/`reason`) per `entity-mapping.md`.

Mark passive hooks and openclaw as `action:"manual"` with a `notes` explanation. Do the same for
telemetry (OTEL env, observability hooks/scripts): map it to `manual` and, per `entity-mapping.md`,
point the user at Archestra's native telemetry instead of migrating it.

Always show the user a concise preview and get explicit approval before applying. Use this shape:

```markdown
## Migration Preview

Ready to create
| Source | Archestra target | Scope | Notes |
| --- | --- | --- | --- |

Needs your decision
| Source | Choice | Recommendation |
| --- | --- | --- |

Manual after migration
| Source | Why manual | Follow-up |
| --- | --- | --- |

Behavior changes to expect
- <only list differences that apply>

Secrets/safety notes
- <redactions and warnings, never secret values>
```

Keep the preview short enough for a pilot owner to approve. Do not show raw API payloads unless the
user asks.

## Step 4 — Apply
Dry-run first (offline; builds + validates every payload, touches no network):
```bash
python3 "$SKILL_DIR/scripts/apply.py" --inventory inventory.json --plan migration_plan.json --dry-run
```
Fix any `invalid` ops (they print the validation error), then apply for real:
```bash
python3 "$SKILL_DIR/scripts/apply.py" --inventory inventory.json --plan migration_plan.json --out migration_result.json
```
`apply.py` is idempotent (skips entities that already exist), records each op's real outcome, calls
`enable-defaults` so the primary agent sees the skills, and best-effort assigns sandbox tools
(`run_command`, `upload_file`, `download_file`) to migrated agents. Sandbox assignment failures are
non-blocking warnings because some Archestra installs do not enable the sandbox runtime yet. The script
exits non-zero if any op failed/was invalid.

## Step 5 — Report
From `migration_result.json`, write `report.md` using `references/report-template.md`. The report is
for deciding whether the converted pilot is ready to try in Archestra, not for producing an exhaustive
command transcript. For unresolved `guard` hooks, include the exact policy JSON to paste once a target
tool exists. Tool-invocation policies only enforce when the org `globalToolPolicy` is `restrictive`;
the scripts don't read that setting, so tell the user to verify it in Archestra settings. Also surface
any `warnings` from the inventory (possible secrets left intact in migrated bodies). Summarize for the
user what migrated, what to test first, and what still needs hands-on work.

## Contributor tooling (not needed to *run* the skill)
The shipped scripts are zero-dependency; the lines below are only for developing/testing them.
Dev deps (`pytest`, `pyyaml`, `ty`, `ruff`) are pinned in `pyproject.toml` under the `dev` group.
```bash
cd "$SKILL_DIR"
uv run --group dev python -m pytest tests/ -q   # tests (incl. the ty + ruff gates)
uv run --group dev ty check                      # Astral type checker, the typing gate
uv run --group dev ruff check                    # Astral linter
```
`ty` is the enforced typing gate (it matches an Astral dev loop). It is a young checker, so a few
validation helpers carry explicit `cast`s where it cannot yet narrow a membership check — mypy would
consider those redundant, which is why mypy is not the gate.
