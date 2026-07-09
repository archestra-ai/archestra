---
title: Migrate to Archestra
category: Archestra Platform
order: 7
---

# Migrate to Archestra

The migration kit turns an existing agentic setup into an Archestra setup. Typical sources are the
unsorted configs left by tools like Claude Code, OpenClaw, or Hermes: project instruction files, MCP
configs, hooks, local scripts, and whatever else accumulated during evaluation.

It ships as a Skill (`migrate-to-archestra`) for your favorite coding agent (e.g. Claude Code), so the migration runs as a guided,
agentic flow rather than a one-shot script. The deterministic work — discovering source artifacts,
redacting secrets, building and validating API payloads — lives in zero-dependency Python helpers;
the model owns the judgment calls (what maps to what, what to skip, what needs review).

The goal is not a byte-for-byte port. It is to get the pilot running in Archestra quickly, with the
important behavior differences surfaced before anything is applied.

## What it produces

- A primary agent from the project's instruction file.
- Skills from existing skills, subagents, slash commands, and local tools.
- Private MCP catalog items, installed only on request.
- LLM provider keys, only when you paste the replacement secret.
- A report separating what moved, what was skipped, what failed, and what needs hands-on review.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/archestra-ai/archestra/main/migration-kit/install.py | python3
```

The kit is zero-dependency (stock `python3` ≥ 3.10, standard library only), so the helpers run on
locked-down or air-gapped hosts. Then open Claude Code near the source project and ask it to use the
`migrate-to-archestra` skill against your Archestra instance.

## Flow

1. Connect to an Archestra instance, or start a local one (skill can help with that too).
2. Discover the source setup into a secret-redacted `inventory.json`.
3. Draft a preview plan and confirm the few decisions that matter (scope, which MCP servers to
   install, which keys to migrate).
4. Dry-run, then apply the approved plan.
5. Get a report with migrated items, manual follow-up, and behavioral differences.

## Typical migration plan

- **Subagents** become skills — instructions migrate, but isolation and tool allowlists are
  documented, not enforced.
- **MCP servers** become catalog items; installing them is opt-in because local stdio servers run
  inside Archestra's Kubernetes-backed runtime.
- **Guard hooks** become tool policies only when the target tool exists in Archestra.
- **Lifecycle hooks** (`SessionStart`, `PreToolUse`, `PostToolUse`) become native Archestra hooks when possible.
- **Passive hooks, openclaw config, and unknown files** are reported for manual follow-up.
- **Telemetry/observability** is reported, not migrated: Archestra emits OpenTelemetry traces and
  Prometheus metrics natively (see [Observability](/docs/platform-observability)), so the report
  points you at that instead.

The full source, reference docs, and contributor tooling live in the
[`migration-kit/`](https://github.com/archestra-ai/archestra/tree/main/migration-kit) directory.
