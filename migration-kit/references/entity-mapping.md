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
| `local_tool` (`tools/*.py`) | `skill` | best-effort | skill bundles the `.py` and tells the agent to run it |
| `mcp_server` (remote, has `url`) | `mcp_catalog` (+ optional `mcp_install`) | clean | remote catalog item |
| `mcp_server` (stdio, has `command`) | `mcp_catalog` (+ optional `mcp_install`) | best-effort | local catalog item; install spins a K8s pod |

When you emit both a `mcp_catalog` and a `mcp_install` decision for the same server, they must share the
same `name`/`name_override`: the install resolves its catalog item **by name**, so a mismatch fails with
"no catalog item named …". `apply.py` runs all `mcp_catalog` ops before any `mcp_install`.
| `hook` (intent `guard`) | `tool_policy` | best-effort, conditional | only if the guarded tool maps to a real Archestra tool — see below |
| `hook` (intent `passive`) | `manual` | report | logging/inject hooks have no Archestra equivalent |
| `openclaw` | `manual` | report | runtime config; schema unverified — report, don't translate |
| LLM key (user-provided) | `llm_key` | best-effort | user pastes the secret in `user_answers.apiKey` |

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
