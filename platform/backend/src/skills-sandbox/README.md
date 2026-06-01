# Skill Sandbox Runtime

DB-backed, Dagger-materialized execution sandbox for Agent Skills.

## What this directory contains

- `skill-sandbox-runtime-service.ts` — singleton service that owns the Dagger
  client. Materializes a sandbox from its DB recipe, replays the persisted
  command log, executes a new command, and exports files as artifacts. Mirrors
  the structure of `../code-runtime/code-runtime-service.ts` (status FSM,
  semaphore, lifecycle hooks).
- `runtime-image.ts` — base image (`ghcr.io/astral-sh/uv:…`), apt-package
  baseline (bash, curl, git, jq, nodejs, npm, build-essential), non-root user
  (`1000:1000`), and skill-root layout (`/skills/<skill-name>`).
- `types.ts` — `SkillSandboxLimits`, `CommandResult`, `ArtifactRef`,
  `SkillSandboxError`, runtime status enum. Tool-layer code in
  `../archestra-mcp-server/skill-sandbox.ts` re-uses these so the
  service/tool boundary stays typed end-to-end.

## Source of truth

- Postgres owns the durable recipe:
  - `skill_sandboxes` — metadata (owner, image, default cwd, primary skill)
  - `skill_sandbox_skills` — junction of skills mounted at create time
  - `skill_sandbox_commands` — ordered command log (replay input)
  - `skill_sandbox_artifacts` — exported file bytes (bytea)
- Dagger owns ephemeral filesystem state. There is no retention guarantee; if
  the engine restarts or evicts a cached layer, replay rebuilds the container
  from the DB recipe.

## Replay semantics

Every `runCommand` materializes a fresh container from the base image, mounts
the snapshotted skill files at their `/skills/<name>` roots, then replays the
full persisted command log before executing the new command. Dagger's layer
cache keeps the hot path fast; on a cold cache replay is slower but still
deterministic for deterministic commands. Non-deterministic commands (network
calls, time/RNG) are accepted as a v1 limitation — the recorded `stdout`
remains the canonical observation for the original run, even if a later replay
would diverge. Live processes are not durable.

## Limits

Runtime resource defaults are surfaced through `config.skillsSandbox` so admins
can tune them via env vars:

- `cpuLimit` — CPU cap per command
- `memoryLimit` — container memory cap
- `wallClockSeconds` — wall-clock cap per command (clamped against caller request)
- `artifactBytesLimit` — cap on exported file size
- `outputBytesLimit` — cap on stdout/stderr captured into the command log

Fixed API limits live in `types.ts` (`SKILL_SANDBOX_LIMITS`), including command
input length and the per-sandbox pending queue length.

The sandbox always runs as the non-root user from `runtime-image.ts`, with no
host mounts and no backend env exposed inside the container. Network access is
enabled because npm/uv/npx require it; this is documented in the activation
prompt.

## RBAC

All three sandbox MCP tools are gated by `skill:execute`
(`backend/src/auth/skill-permissions.ts`). `create_skill_sandbox` additionally
requires `skill:read` for every skill being mounted and respects per-skill
team scoping. Sandboxes are owner-scoped: `run_skill_command` and
`get_skill_sandbox_artifact` reject access to a sandbox the caller does not
own within the same organization.
