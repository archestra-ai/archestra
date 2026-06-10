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
| `hook` (event maps; any intent) | `hook` (native) | clean, preferred | Claude's `SessionStart`/`PreToolUse`/`PostToolUse` → a real Archestra lifecycle hook; the payload is Claude-compatible so the script ports near-1:1 — see below |
| `hook` (intent `guard`, simple condition) | `tool_policy` | alt to `hook` | only when the guard is a clean `{key,operator,value}` on a real Archestra tool — see below |
| `hook` (event unmapped, or script `unresolved`) | `manual` | report | `UserPromptSubmit`/`Stop`/… have no Archestra event; an unresolvable script body can't become a hook |
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

## Hooks → native lifecycle hooks (preferred)
Archestra runs per-agent `.py`/`.sh` lifecycle hooks at `session_start`/`pre_tool_use`/`post_tool_use`,
in the conversation sandbox, with a **Claude-compatible** stdin payload (`hook_event_name`, `tool_name`,
`tool_input`, `tool_response`, `session_id`, `cwd`) and the same exit-code protocol (`2` blocks with
stderr as the reason; `0` proceeds with stdout injected; errors/timeout fail open). So most Claude Code
hooks for those three events port near-1:1 as a `hook` target — that is the default.

`discover.py` does the mechanical part and records it on each `hook` item's `data.source`:
- **bundled** — the command referenced a script in the tree (e.g. `python3 "$CLAUDE_PROJECT_DIR/hooks/x.py"`);
  the script is bundled and `file_name` is its basename. PEP-723 `dependencies` from a `.py` are pulled
  into `data.requirements`.
- **inline** — a self-contained shell snippet; `apply.py` synthesizes a `#!/bin/sh` wrapper into a `.sh`.
  "Self-contained" is the classifier's assumption, not a guarantee: only `.py`/`.sh` references are
  detected as scripts, so a command running any other repo file (`node hooks/check.js`, `./check`)
  lands here yet would reference a file that does not exist in the sandbox. Before approving an
  inline hook, check its command for repo-file references and map such hooks `manual`.
- **unresolved** — a missing/escaping script or unparsable command; map it `manual`.

What you author per hook decision (`target_kind:"hook"`): usually nothing. Optional `user_answers`:
`agentId` (UUID; defaults to the primary migrated agent), `fileName` (override; must match the basename
regex), `requirements` (override the PEP-723 list; a `.sh` hook must have none). `apply.py` builds and
validates the payload, attaches it to the primary agent, and skips an existing `(agentId, event, fileName)`.

**Behavior differences to surface (no native equivalent — list them in the report):**
- **No matcher.** Claude's `matcher` (`"Bash"`, `"Edit|Write"`, `"*"`) is gone; an Archestra hook fires
  for **every** tool call of its event. The script must self-filter on `tool_name`.
- **Tool names differ.** Archestra names (`run_command`, `server__tool`) ≠ Claude built-ins (`Bash`,
  `Read`); a script comparing `tool_name == "Bash"` won't match anything.
- **`cwd` is the sandbox home**, not the source project; `$CLAUDE_PROJECT_DIR`/`transcript_path` are absent.
- **Dropped env/argv.** A command like `TOKEN=… python3 x.py --flag` loses its env var and args — hooks
  take neither. discover flags these in the item summary.

## Hooks → tool policies (the declarative alternative)
A deterministic `PreToolUse` guard (e.g. "block Bash commands matching `rm -rf /`") can instead map to a
tool-invocation policy: `{toolId, conditions:[{key,operator:"regex",value}], action:"block_always", reason}`.
Prefer this over a native `hook` only when the guard is a clean declarative condition **and** the guarded
tool exists in Archestra (so it has a `toolId`) **and** the org enforces policies. Otherwise the native
`hook` is the more faithful port.

A policy attaches to a **tool that exists in Archestra**. Claude Code built-ins (Bash, Read, Write…) are
not Archestra tools, so a guard on `Bash` has no policy target. Therefore:
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
- **Hooks** for `SessionStart`/`PreToolUse`/`PostToolUse` migrate as native lifecycle hooks, but lose the
  `matcher` (fire for every tool call), assume Archestra tool names, run with `cwd` = sandbox home, and
  drop any command env/argv. Hooks for other events have no equivalent — list them.
- **Artifact/filename conventions** enforced only by prompt rules carry over as prose, not as code.
- **Local stdio MCP servers** are registered but only run if installed (opt-in) and resolvable in the cluster.

## Report (`report.md`)
Use `references/report-template.md`. The report should help a pilot owner decide what is ready to try
in Archestra, what was skipped or failed, and what still needs hands-on follow-up. Include behavioral
differences from the list above only when they apply to the actual migration.
