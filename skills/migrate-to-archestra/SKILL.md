---
name: migrate-to-archestra
description: Migrate an existing agentic setup (Claude Code project — skills, subagents, slash commands, hooks, MCP servers, CLAUDE.md, local python tools, optional openclaw config) into an Archestra instance. Use when the user wants to move, port, or migrate their Claude/agentic setup to Archestra.
license: Apache-2.0
---

# Migrate an agentic setup to Archestra

You migrate a user's agentic setup into Archestra. The mechanical, deterministic work lives in
bundled Python helpers (run via `uv`); you own the judgment: mapping decisions, asking the user where
ambiguous, and writing the final report.

`$SKILL_DIR` below is the directory containing this file. The helpers are at `$SKILL_DIR/scripts/`.
They declare their own deps inline, so plain `uv run "$SKILL_DIR/scripts/<x>.py"` just works.

The spine — three JSON artifacts, with you applying judgment in the middle:

```
discover.py → inventory.json → [you map + ask the user] → migration_plan.json → apply.py → migration_result.json → [you write report.md]
  deterministic                       judgment                                     deterministic
```

Read `references/entity-mapping.md` before mapping, `references/archestra-api.md` for payload facts,
and `references/install.md` for connecting/installing. Do them as you reach each step, not all upfront.

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
uv run "$SKILL_DIR/scripts/discover.py" <source_dir> --out inventory.json
```
This emits a **secret-redacted** inventory (it never writes credentials to the file). Read
`inventory.json`. For items you'll map, skim the relevant bodies. Note anything in `unknowns`.

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
- whether each subagent should be a `skill` (default) or a full `agent`;
- whether to also **install** each MCP server now (`mcp_install`) or just register the catalog item
  (installing a local stdio server spins a K8s pod). If you emit both a `mcp_catalog` and a
  `mcp_install` decision for one server, give them the **same** `name`/`name_override` — the install
  resolves its catalog item by name;
- which LLM keys to migrate — and have the user paste each secret into `user_answers.apiKey`
  (with `provider`). Never read a secret out of their files.
- for each `guard` hook, extract its semantics into `user_answers`
  (`tool_name`, `key`, `operator`, `value`, optional `action`/`reason`) per `entity-mapping.md`.

Mark passive hooks and openclaw as `action:"manual"` with a `notes` explanation.

Always show the user the plan (what will be created, at what scope) and get approval before applying.

## Step 4 — Apply
Dry-run first (offline; builds + validates every payload, touches no network):
```bash
uv run "$SKILL_DIR/scripts/apply.py" --inventory inventory.json --plan migration_plan.json --dry-run
```
Fix any `invalid` ops (they print the validation error), then apply for real:
```bash
uv run "$SKILL_DIR/scripts/apply.py" --inventory inventory.json --plan migration_plan.json --out migration_result.json
```
`apply.py` is idempotent (skips entities that already exist), records each op's real outcome, calls
`enable-defaults` so the primary agent sees the skills, and exits non-zero if any op failed/was invalid.

## Step 5 — Report
From `migration_result.json`, write `report.md` with the sections defined in
`references/entity-mapping.md` (Migrated / Skipped / Failed / Manual migration needed / Behavioral
differences). For unresolved `guard` hooks, include the exact policy JSON to paste once a target tool
exists. Tool-invocation policies only enforce when the org `globalToolPolicy` is `restrictive`; the
scripts don't read that setting, so tell the user to verify it in Archestra settings. Also surface any
`warnings` from the inventory (possible secrets left intact in migrated bodies). Summarize for the user
what migrated and what still needs hands-on work.

## Tests
```bash
cd "$SKILL_DIR" && uv run --with pytest --with pyyaml --with pydantic --with httpx python -m pytest tests/ -q
```
