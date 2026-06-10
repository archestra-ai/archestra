# Skill Sandbox Runtime

DB-backed, Dagger-materialized execution sandbox for Agent Skills.

> Gated behind the sandbox feature flag (`config.skillsSandbox`, derived from
> `ARCHESTRA_CODE_RUNTIME_ENABLED` + a Dagger runner host).

## What this directory contains

- `skill-sandbox-runtime-service.ts` — singleton service that owns the Dagger
  client. Materializes a sandbox from its DB replay log, replays it, executes a
  new command, and exports files as artifacts (status FSM, per-sandbox queue,
  lifecycle hooks).
- `runtime-image.ts` — container path layout: skill root (`/skills/<skill-name>`),
  sandbox home, and attachment staging dir. The image itself (base image,
  apt-package baseline, non-root user) is defined in the Rust Dagger backend
  (`platform/archestra-rs/sandbox-core/src/backends/dagger.rs`).
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
    bytes copied *out* of a materialized container for download. An upload
    auto-staged from a chat attachment records its `source_attachment_id`; a
    partial unique index `(sandbox_id, source_attachment_id)` makes re-staging a
    DB-level no-op
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

## Chat attachment auto-staging

Files the user attaches in chat are auto-staged into the conversation's
**default** sandbox so the model can use them without juggling attachment ids
(the failure mode that motivated this: the model can't see attachment ids, so it
otherwise guesses). On each `run_command` / `download_file`, before context is
built, `stageConversationAttachments` (in `skill-sandbox-runtime-service.ts`,
run inside the per-sandbox queue) appends an upload replay event for every
not-yet-staged attachment of the sandbox's conversation, at
`/home/sandbox/attachments/<sanitized-name>` (duplicate names get a short
attachment-id suffix). It is idempotent (tracked via `source_attachment_id` +
the partial unique index) and multi-turn safe (attachments added later stage on
the next op). Only the conversation's default sandbox is staged — `{ fresh }` /
`{ id }` sandboxes are not. Attachments over `artifactBytesLimit` are skipped
with a model-visible notice (returned in `stagingNotices`) rather than silently
dropped. `upload_file` remains the path for inline base64/text content, explicit
paths, non-default sandboxes, and non-chat-UI gateway clients (which have no
`conversation_attachments`).

## Python environment

The warm base image makes `/home/sandbox` a uv **project**: a `pyproject.toml`
plus the project venv at `/home/sandbox/.venv` (on `PATH`, so `python3` is the
venv interpreter), seeded with numpy/pandas/httpx. The model installs more with
`uv add --project /home/sandbox <pkg>` (the `--project` flag makes it work from
any cwd, including a skill dir); `pip` is shimmed to fail with that hint. Every
`requirements.txt` a skill bundles (root or nested, e.g. `tools/requirements.txt`)
is installed at mount time through the same project via
`uv add --project /home/sandbox -r <reqs>`, so their deps are recorded in
pyproject/uv.lock and a later model `uv add` cannot prune them. `uv add` is a
replayed network command, so version resolution can drift across cold replays —
pin versions when determinism matters.

Each mounted skill root (`/skills/<name>`) is appended to `PYTHONPATH` at its
mount step (in `archestra-rs/sandbox-core/src/backends/dagger.rs`), so a skill's
modules import directly from anywhere — no `sys.path` edits. The default cwd
stays `/home/sandbox` (never the skill root), so a bundled script that reads its
own files by relative path must be run with `cwd: /skills/<name>`.

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
