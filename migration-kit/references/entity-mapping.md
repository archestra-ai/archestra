# Entity mapping: source primitive → Archestra entity

This is the canonical mapping the model applies when turning `inventory.json` into
`migration_plan.json`. Each decision references an inventory item by `id` and names a
`target_kind`; `apply.py` builds the actual payload deterministically.

| Source (inventory `kind`) | `target_kind` | Confidence | Notes |
|---|---|---|---|
| `claude_md` (root CLAUDE.md) | `agent` | clean | becomes the **primary agent**'s systemPrompt; one per setup, no model binding (inherits org default) |
| `skill` (`.claude/skills/*/SKILL.md`) | `skill` | clean | migrated verbatim with bundled files |
| `subagent` (`.claude/agents/*.md`) | `skill` (preferred) or `agent` | best-effort | default to skill; tool allowlist is **documented, not enforced** |
| `command` (`.claude/commands/*.md`) | `skill` | best-effort | slash command body → skill |
| `local_tool` (`tools/*.py`) | `skill` | best-effort | per-script fallback; PREFER consolidating into one toolset skill — see "Local tools" below |
| `mcp_server` (remote, has `url`) | `mcp_catalog` (+ optional `mcp_install`) | clean | remote catalog item |
| `mcp_server` (stdio, has `command`) | `mcp_catalog` (+ optional `mcp_install`) | best-effort | local catalog item; install spins a K8s pod |

When you emit both a `mcp_catalog` and a `mcp_install` decision for the same server, they must share the
same `name`/`name_override`: the install resolves its catalog item **by name**, so a mismatch fails with
"no catalog item named …". `apply.py` runs all `mcp_catalog` ops before any `mcp_install`.
| `hook` (intent `guard`) | `tool_policy` | best-effort, conditional | only if the guarded tool maps to a real Archestra tool — see below |
| `hook` (intent `passive`) | `manual` | report | logging/inject hooks have no Archestra equivalent |
| `openclaw` | `manual` | report | runtime config; schema unverified — report, don't translate |
| LLM key (user-provided) | `llm_key` | best-effort | user pastes the secret in `user_answers.apiKey` |
| telemetry (OTEL env, observability hooks, metrics-shipping scripts) | `manual` | report | no target — Archestra emits telemetry natively; redirect the collector (see "Telemetry" below) |

## Scope
Ask for ONE default migration scope up front (default `personal`); use per-decision overrides only as
exceptions. Keep the primary agent and its skills in the same scope so the agent can see them. If that
scope is `team`, agent/skill/catalog decisions must include `user_answers.teamIds`; MCP installs and
LLM keys must include `user_answers.teamId` (or exactly one `teamIds` value). Otherwise choose
`personal` or `org` instead. `apply.py` rejects team-scoped decisions without team ids before making
network calls.

## Skill visibility
After creating skills/agents, `apply.py` calls `POST /api/skills/enable-defaults` once, which enables the
org `archestra__{list_skills,activate_skill,read_skill_file}` tools and backfills them onto agents — that
is how the primary agent gains access to the migrated skills (there is no agent↔skill junction).
It also tries to assign sandbox tools (`run_command`, `upload_file`, `download_file`) to migrated agents
so bundled local tools can run from activated skills. Missing/disabled sandbox support is reported as a
non-blocking warning.

## Hooks → tool policies (the nuance)
A deterministic `PreToolUse` guard (e.g. "block Bash commands matching `rm -rf /`") maps exactly to a
tool-invocation policy: `{toolId, conditions:[{key,operator:"regex",value}], action:"block_always", reason}`.

But a policy attaches to a **tool that exists in Archestra**. Claude Code built-ins (Bash, Read, Write…)
are not Archestra tools, so a guard on `Bash` has no target. Therefore:
- The **model** must read the guard script and extract its semantics into `user_answers`:
  `{tool_name, key, operator, value, action?, reason?}`. (Parsing arbitrary guard code is judgment — do it.)
- `apply.py` resolves `tool_name` against `GET /api/tools`. If found → creates the policy. If not found
  (the common case for built-ins) → records `manual` with the ready-to-paste policy in the report.
- Policies only enforce when the org `globalToolPolicy` is `restrictive`. Tell the user; don't flip it silently.

## Telemetry & observability → leverage Archestra's native telemetry (report-only)
If the source ships its own telemetry, **don't migrate it** — Archestra already emits richer telemetry
natively and automatically: an OpenTelemetry span per LLM call and per MCP tool invocation, plus
Prometheus metrics (tokens, cost, latency, blocked-tools), with no per-agent setup. So a setup's
telemetry instrumentation is redundant. Map it to `manual` and, in the report, point the pilot owner at
the native capability instead.

Watch for telemetry in any of: an OTEL `env` block in `settings*.json` (`CLAUDE_CODE_ENABLE_TELEMETRY`,
`OTEL_*`), hooks that POST spans/metrics to a collector, or plain `local_tool`/hook scripts that ship
metrics or logs. Naming won't always say so — read the body when a hook/tool looks observability-shaped.

Redirect, don't translate:

| Source telemetry | Use Archestra's instead |
|---|---|
| per-tool-call timing/usage hooks | OTEL span + Prometheus metrics per MCP tool call (automatic) |
| LLM token/cost logging | `llm_tokens_total`, `llm_cost_total`, `llm_request_duration_seconds` |
| custom OTLP exporter (env/hook) | native OTLP export via `ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT` (`/v1/traces`, `/v1/logs`) |
| scraping a local metrics file | Prometheus `/metrics` on `ARCHESTRA_METRICS_PORT` (default `:9050`) |

Telemetry is **instance-level env config** — no API, no per-agent knob. To keep an existing
Grafana/collector, the pilot owner sets `ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT` on the instance.

## Local tools: consolidate before migrating (judgment, not tooling)
Migrating each `tools/*.py` as its own wrapper skill scatters one toolset across many skills, and
skills/commands that say "run `python3 tools/<x>.py`" dangle after migration (the script ends up in
a different skill's mount → file-not-found at runtime). Prefer consolidating, using ordinary file
edits in the source before applying:

1. Author `.claude/skills/<project>-tools/` in the source: a `SKILL.md` listing each tool and how to
   run it (`python3 /skills/<project>-tools/tools/<x>.py`; outputs to absolute paths under
   `/home/sandbox`), the scripts (plus any data files they read), and — if they import third-party
   packages — a `requirements.txt` at the **skill root**, which Archestra auto-installs when the
   skill is mounted. Curate it from `tools/requirements.txt`; don't copy the project's root
   `requirements.txt` wholesale (it usually pins the whole app).
2. Re-run discovery: the toolset is now a clean `skill` item, bundled verbatim. `skip` the
   per-script `local_tool` items so nothing migrates twice.
3. Rewrite references in other migrated skills/commands/subagents from `tools/<x>.py` prose to
   "activate `<project>-tools`, then `python3 /skills/<project>-tools/tools/<x>.py`" — or list each
   un-rewritten reference in the report as a manual follow-up. Never leave them dangling silently.
4. If a skill named `<project>-tools` already exists in the org, pick another name everywhere —
   `apply.py` treats same-name/scope as already-migrated and records a `skipped` result (no
   warning or error), so the toolset would quietly not be uploaded.

Fall back to per-script `local_tool` migration only for a single independent script that nothing
else references.

## Behavioral differences to put in the report
- **Subagent isolation & tool allowlists are not preserved.** Archestra skills are instructions, not
  isolated agents with enforced tool permissions. The migrated skill documents the original allowlist only.
- **Hooks** that log/inject/observe (SessionStart banners, PostToolUse logging) have no equivalent — list them.
- **Artifact/filename conventions** enforced only by prompt rules carry over as prose, not as code.
- **Local stdio MCP servers** are registered but only run if installed (opt-in) and resolvable in the cluster.

## Report (`report.md`)
Use `references/report-template.md`. The report should help a pilot owner decide what is ready to try
in Archestra, what was skipped or failed, and what still needs hands-on follow-up. Include behavioral
differences from the list above only when they apply to the actual migration.
