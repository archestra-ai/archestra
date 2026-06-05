# Skill Sandbox Runtime

DB-backed, Dagger-materialized execution sandbox for Agent Skills.

> Not released yet: the sandbox is gated behind the sandbox feature flag
> (`config.skillsSandbox`, derived from `ARCHESTRA_CODE_RUNTIME_ENABLED` + a
> Dagger runner host).

## What this directory contains

- `skill-sandbox-runtime-service.ts` — singleton service that owns the Dagger
  client. Materializes a sandbox from its DB replay log, replays it, executes a
  new command, and exports files as artifacts (status FSM, per-sandbox queue,
  lifecycle hooks).
- `runtime-image.ts` — base image (`ghcr.io/astral-sh/uv:…`), apt-package
  baseline (bash, curl, git, jq, nodejs, npm, build-essential), non-root user
  (`1000:1000`), and skill-root layout (`/skills/<skill-name>`).
- `types.ts` — `SkillSandboxLimits`, `CommandResult`, `ArtifactRef`,
  `UploadRef`, `SkillSandboxError`, runtime status enum. Tool-layer code in
  `../archestra-mcp-server/sandbox.ts` re-uses these so the service/tool
  boundary stays typed end-to-end.

## Source of truth

- Postgres owns the durable replay recipe:
  - `skill_sandboxes` — metadata (owner, image, default cwd, `is_default`) plus
    `next_replay_sequence`, the atomic allocator for replay ordering
  - `skill_sandbox_skill_mounts` — skills mounted into the sandbox, each pinning
    an immutable `skill_version_id` (so editing a skill mid-conversation never
    mutates a running sandbox)
  - `skill_sandbox_commands` — executed-command payloads
  - `skill_sandbox_files` — file bytes (bytea), role-tagged by `kind`: an
    `upload` is input bytes written *into* the sandbox; an `artifact` is output
    bytes copied *out* of a materialized container for download
  - `skill_sandbox_replay_events` — the ordered replay log: one sequenced row per
    command, upload, or skill mount, each pointing at its payload. This is the
    replay input. A generated `file_kind = 'upload'` + composite FK constrains
    an event's `file_id` to only ever reference an `upload`-kind file row
  - skill bytes themselves live in `skill_versions` + `skill_version_files`
    (immutable per version); a mount references a version, not the live skill
- Dagger owns ephemeral filesystem state. There is no retention guarantee; if
  the engine restarts or evicts a cached layer, replay rebuilds the container
  from the DB recipe.

Uploads vs artifacts: an **upload** must live in the replay log (not as an
artifact), otherwise a later cache-cold rebuild would reconstruct a sandbox
missing the uploaded file. An **artifact** is a terminal output, recorded only
for download.

## Replay semantics

Every `run_command` materializes a fresh container from the base image, then
replays the full ordered `skill_sandbox_replay_events` log before executing the
new command. Each event is applied in `sequence` order: a command re-executes,
an upload re-writes its bytes at its absolute path, a skill mount writes the
pinned version's `SKILL.md` (+ its version files) under `/skills/<name>`.
Interleaving is preserved, so a file uploaded between command A and command B is
**not** present while A replays — the on-disk order always matches the order
operations were accepted.

`upload_file` does no Dagger work itself; it persists the bytes as an upload
event (serialized through the same per-sandbox queue as commands, so its
sequence lands deterministically relative to in-flight runs). The file
materializes on the next `run_command` / `download_file` replay.

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

The sandbox MCP tools (`run_command`, `upload_file`, `download_file`) are gated
by `sandbox:execute` (`backend/src/archestra-mcp-server/rbac.ts`). Sandboxes are
scoped to the caller's organization + user + **conversation**: a `target: { id }`
referencing a sandbox outside that scope is rejected.

Skills are mounted into the default sandbox by `activate_skill` (and
slash-command activation), which enforces `skill:read` + per-skill team scope
for the activating user. Before building any container, `run_command` and
`download_file` re-check that every mounted skill is still readable by the
caller (revocation gate) and fail closed otherwise.

`upload_file` with a `chat_attachment` source reads the bytes server-side
(never through model context) and requires the attachment to belong to both the
caller's organization and the **current conversation** — an attachment from
another conversation is rejected to block cross-conversation exfiltration.
