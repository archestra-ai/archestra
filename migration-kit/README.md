# migration-kit

A self-contained kit for migrating an existing Claude Code / agentic setup into
[Archestra](https://github.com/archestra-ai/archestra). It ships as a Claude Code **skill**
(`migrate-to-archestra`) plus a one-command installer.

This lives at the repo top level — not under `skills/`, which is for Archestra developers —
because the audience here is **Archestra users and admins** evaluating a PoC or pilot.

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

After installing, open Claude Code and run the `migrate-to-archestra` skill.

## What the skill does

`discover.py` inventories your setup (skills, subagents, slash commands, hooks, MCP servers,
`CLAUDE.md`, local tools), redacting secrets. You map that inventory to Archestra entities with
judgment; `apply.py` builds and applies the migration. See [`SKILL.md`](SKILL.md) for the full flow
and [`references/`](references/) for entity mapping and API details.

The shipped scripts are **zero-dependency and fully typed**, so they run on locked-down or
air-gapped enterprise hosts with nothing installed.

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
