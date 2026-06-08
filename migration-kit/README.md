# migration-kit

Turn an existing agentic PoC into an [Archestra](https://github.com/archestra-ai/archestra) pilot.

The kit is packaged as a Claude Code **skill** (`migrate-to-archestra`) because that gives the
migration a guided, agentic runner. The source setup does not need to be one clean project shape: it
can include Claude Code-style files, MCP configs, local scripts, hooks, openclaw config, and other
hand-rolled pilot artifacts that often accumulate during evaluation.

This lives at the repo top level — not under `skills/`, which is for Archestra developers — because
the audience here is **users and admins evaluating whether to move an existing PoC/pilot into
Archestra**.

## What you get

- A primary Archestra agent from project-level instructions when present.
- Archestra skills from existing skills, subagents, slash commands, and local tools.
- Private MCP catalog items, with optional install when the user wants to run them in Archestra.
- LLM provider keys only when the user explicitly pastes the replacement secret.
- A migration report that separates what moved, what was skipped, what failed, and what still needs
  hands-on review.

The goal is not a perfect byte-for-byte port of every runtime behavior. The goal is to get the pilot
running in Archestra quickly, with the important behavior differences visible before the user applies
anything.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/feat/migrate-to-archestra-skill/migration-kit/install.py | python3
```

<!-- TODO: after this merges, switch the URL above to .../archestra-ai/archestra/main/migration-kit/install.py -->

The installer is zero-dependency (stock `python3` ≥ 3.10, stdlib only — no `uv`, no `pip`). Via the
GitHub contents API it downloads **only the files needed to run the skill** — `SKILL.md`, `scripts/`,
and `references/` (~90 KB, not the whole repo) — into your Claude Code skills directory. Tests,
packaging, and this installer itself are not installed.

Default install location: `~/.claude/skills/migrate-to-archestra/`.

After installing, open Claude Code in or near the source project and ask:

```text
Use the migrate-to-archestra skill to migrate this pilot into my Archestra instance.
```

If the source project or Archestra instance is somewhere else, include those explicitly:

```text
Use the migrate-to-archestra skill to migrate /path/to/pilot into http://localhost:9000.
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--ref` | `feat/migrate-to-archestra-skill` | Git ref (branch, tag, or commit SHA) to install from. |
| `--dest` | `~/.claude/skills/migrate-to-archestra` | Install directory. |
| `--force` | off | Overwrite an existing non-empty destination. |

To pin a specific commit, or to install without piping to a shell:

```bash
curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/<ref>/migration-kit/install.py -o install.py
python3 install.py --ref <commit-sha> --dest ./migrate-skill
```

## Migration flow

The skill guides five steps:

1. Connect to an existing Archestra instance or start a local one.
2. Discover the source setup into a secret-redacted `inventory.json`.
3. Draft a human-readable preview plan and ask for the few decisions that matter.
4. Dry-run, then apply the approved plan.
5. Write a report for the pilot owner with migrated items, manual follow-up, and behavioral
   differences.

## What the scripts do

`discover.py` inventories the setup, redacting secrets from structured config. The skill turns that
inventory into migration decisions with user approval. `apply.py` builds and applies the approved
plan. See [`SKILL.md`](SKILL.md) for the full flow and [`references/`](references/) for entity
mapping, API details, and the report template.

The shipped scripts are **zero-dependency and fully typed**, so they run on locked-down or air-gapped
enterprise hosts with nothing installed.

## What needs review

- Subagents usually become skills. Their instructions migrate, but Claude Code-style isolation and
  tool allowlists are documented rather than enforced.
- MCP servers become catalog items. Installing them is opt-in because local stdio servers run inside
  Archestra's Kubernetes-backed runtime.
- Guard hooks can become tool policies only when the target tool exists in Archestra.
- Passive hooks, openclaw config, and unknown files are reported for manual follow-up.
- Secrets inside migrated prose/code bodies are left intact because they are part of the artifact, but
  discovery warns so the user can review them before sharing the inventory.

## Developing

Contributor tooling (not needed to *run* the skill) is pinned in `pyproject.toml` under the `dev`
group:

```bash
uv run --group dev pytest -q   # tests, incl. the type / lint / zero-dependency gates
uv run --group dev ty check    # Astral type checker (the enforced typing gate)
uv run --group dev ruff check  # Astral linter
```

CI runs these on every PR via the **Migration Kit Checks** job. The zero-dependency guarantee is
itself a test: `tests/test_zero_dependency.py` statically asserts every shipped script imports only
the standard library.
