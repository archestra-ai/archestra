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
  `UploadRef`, `SkillSandboxError`, runtime status enum. Tool-layer code in
  `../archestra-mcp-server/skill-sandbox.ts` re-uses these so the
  service/tool boundary stays typed end-to-end.

## Source of truth

- Postgres owns the durable recipe:
  - `skill_sandboxes` — metadata (owner, image, default cwd, primary skill) plus
    `next_replay_sequence`, the atomic allocator for replay ordering
  - `skill_sandbox_skills` — junction of skills mounted at create time
  - `skill_sandbox_commands` — executed-command payloads
  - `skill_sandbox_uploads` — uploaded input file bytes (bytea)
  - `skill_sandbox_replay_events` — the ordered replay log: one sequenced row per
    command or upload, each pointing at its payload. This is the replay input
  - `skill_sandbox_artifacts` — exported (output) file bytes (bytea)
- Dagger owns ephemeral filesystem state. There is no retention guarantee; if
  the engine restarts or evicts a cached layer, replay rebuilds the container
  from the DB recipe.

Uploads vs artifacts: an **artifact** is output bytes copied *out* of a
materialized container, recorded for download. An **upload** is input bytes
written *into* the sandbox; it must live in the replay recipe (not as an
artifact), otherwise a later cache-cold rebuild would reconstruct a sandbox
missing the uploaded file.

## Replay semantics

Every `runCommand` materializes a fresh container from the base image, mounts
the snapshotted skill files at their `/skills/<name>` roots, then replays the
full ordered `skill_sandbox_replay_events` log before executing the new command.
Each event is applied in `sequence` order: a command re-executes, an upload
re-writes its bytes at its absolute path. Interleaving is preserved, so a file
uploaded between command A and command B is **not** present while A replays —
the on-disk order always matches the order operations were accepted.

`upload_skill_sandbox_file` does no Dagger work itself; it persists the bytes as
an upload event (serialized through the same per-sandbox queue as commands, so
its sequence lands deterministically relative to in-flight runs). The file
materializes on the next `runCommand` / `getArtifact` replay.

Dagger's layer cache keeps the hot path fast; on a cold cache replay is slower
but still deterministic for deterministic commands. Non-deterministic commands
(network calls, time/RNG) are accepted as a v1 limitation — the recorded
`stdout` remains the canonical observation for the original run, even if a later
replay would diverge. Live processes are not durable.

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

All four sandbox MCP tools are gated by `skill:execute`
(`backend/src/auth/skill-permissions.ts`). `create_skill_sandbox` additionally
requires `skill:read` for every skill being mounted and respects per-skill
team scoping. Sandboxes are owner-scoped: `run_skill_command`,
`get_skill_sandbox_artifact`, and `upload_skill_sandbox_file` reject access to a
sandbox the caller does not own within the same organization.

`upload_skill_sandbox_file` with a `chat_attachment` source reads the bytes
server-side (never through model context) and requires the attachment to belong
to both the caller's organization and the **current conversation** — an
attachment from another conversation is rejected to block cross-conversation
exfiltration.
