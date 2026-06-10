# migration-kit

Turn an existing agentic PoC into an [Archestra](https://github.com/archestra-ai/archestra) pilot.

Packaged as a Claude Code **skill** (`migrate-to-archestra`) so the migration runs as a guided,
agentic flow. The source setup can be messy: Claude Code-style files, MCP configs, local scripts,
hooks, openclaw config, and whatever else accumulated during evaluation.

The goal is not a byte-for-byte port — it's to get the pilot running in Archestra quickly, with the
important behavior differences surfaced before anything is applied.

## What you get

- A primary agent from project-level instructions.
- Skills from existing skills, subagents, slash commands, and local tools.
- Private MCP catalog items, installed only on request.
- LLM provider keys only when you paste the replacement secret.
- A report separating what moved, what was skipped, what failed, and what needs hands-on review.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/feat/migrate-to-archestra-skill/migration-kit/install.py | python3
```

<!-- TODO: after merge, switch the URL to .../archestra/main/migration-kit/install.py -->

Zero-dependency (stock `python3` ≥ 3.10, stdlib only). The installer pulls **only the files the skill
needs** — `SKILL.md`, `scripts/`, `references/` (~90 KB) — into `~/.claude/skills/migrate-to-archestra/`.

Then open Claude Code near the source project and ask:

```text
Use the migrate-to-archestra skill to migrate this pilot into my Archestra instance.
```

Point it elsewhere by naming paths explicitly:

```text
Use the migrate-to-archestra skill to migrate /path/to/pilot into http://localhost:9000.
```

### Options

| Flag | Default | Meaning |
| --- | --- | --- |
| `--ref` | `feat/migrate-to-archestra-skill` | Git ref (branch, tag, or commit SHA) to install from. |
| `--dest` | `~/.claude/skills/migrate-to-archestra` | Install directory. |
| `--force` | off | Overwrite an existing non-empty destination. |

To pin a commit or avoid piping to a shell:

```bash
curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/<ref>/migration-kit/install.py -o install.py
python3 install.py --ref <commit-sha> --dest ./migrate-skill
```

## Migration flow

1. Connect to an Archestra instance, or start a local one.
2. Discover the source setup into a secret-redacted `inventory.json` (`discover.py`).
3. Draft a preview plan and ask for the few decisions that matter.
4. Dry-run, then apply the approved plan (`apply.py`).
5. Write a report with migrated items, manual follow-up, and behavioral differences.

See [`SKILL.md`](SKILL.md) for the full flow and [`references/`](references/) for entity mapping, API
details, and the report template. Shipped scripts are zero-dependency and fully typed, so they run on
locked-down or air-gapped hosts.

## What needs review

- **Subagents** become skills — instructions migrate, but isolation and tool allowlists are
  documented, not enforced.
- **MCP servers** become catalog items; installing them is opt-in because local stdio servers run
  inside Archestra's Kubernetes-backed runtime.
- **Guard hooks** become tool policies only when the target tool exists in Archestra.
- **Passive hooks, openclaw config, and unknown files** are reported for manual follow-up.
- **Secrets inside migrated prose/code** are left intact as part of the artifact; discovery warns so
  you can review before sharing the inventory.

## Developing

Contributor tooling (not needed to run the skill) is pinned in `pyproject.toml` under the `dev` group:

```bash
uv run --group dev pytest -q   # tests, incl. type / lint / zero-dependency gates
uv run --group dev ty check    # type checker (enforced typing gate)
uv run --group dev ruff check  # linter
```

CI runs these on every PR via **Migration Kit Checks**. The zero-dependency guarantee is itself a
test: `tests/test_zero_dependency.py` asserts every shipped script imports only the standard library.
