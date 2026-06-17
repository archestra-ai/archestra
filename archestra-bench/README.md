# archestra-bench

A benchmark / trajectory generator for Archestra's core agentic features. Tasks are grouped into
**environments** (`envs/<id>.toml`): a bundle of web-pinned skills, remote MCP servers, and a single
agent, plus the ids of the tasks that run against that surface. Each environment boots its own fresh,
isolated Archestra backend, seeds its surface, drives agentic chat sessions to solve its tasks,
grades the submitted answers out of band, and tears the instance down. Results aggregate by
environment and by task.

## Scope & non-goals

This is an **internal product eval**: it measures whether Archestra correctly assembles a skill +
MCP + agent surface and drives an agent through realistic, multi-stage sessions — not generic model
capability. Chasing a public leaderboard is an explicit non-goal; the asset we invest in is native
tasks derived from real Archestra workflows, each one permanent regression protection.

## Protocol

```
start the harness-owned benchmark MCP (submit_result) in-process
  -> for each environment:
       boot a fresh backend on a new port over a fresh, migrated database
         (reusing the dev stack's shared Postgres + Dagger engine)
       -> seed: provider key + models, the env's web-pinned skills, its remote MCPs,
                the benchmark MCP; create the env's agent and lock its tool surface
       -> for each task x model:
            drive the task's ordered conversation stages (user asks X -> corrects to Y),
            saving the trajectory as coalesced message-level events
       -> read the submission (and, for file-producing tasks, download the produced
          artifact) and verify out of band
       -> drop the database + kill the backend
  -> aggregate by env and by task, write artifacts
```

The agent hands in its answer by calling the benchmark MCP's `submit_result` tool. That tool checks
only the **format** of the answer (against the task's JSON-schema) and, on a malformed payload,
returns a structured error so the model self-corrects within its own tool loop — bounded by a small
attempt budget. Real correctness is checked **out of band** by the task's verifier, which never
enters the sandbox or the MCP, so the agent can never read or game it. The verifier is a pytest file
that reads, by fixed env names the harness sets:

- `BENCH_RESULT` — the submitted JSON result (always set).
- `BENCH_FIXTURES` — a dir holding the task's `inputs/` and `expected/`, set iff either exists.
- `BENCH_OUTPUT` — a file the agent produced and exported, set iff the task declares `artifact_key`.
- `BENCH_STATE` — a JSON snapshot of backend REST state plus the run's tool calls, set iff the task
  declares `[state].rest` (see below). For tasks whose effect is *backend state* — e.g. "did the
  agent create a skill", "how many tools/skills have a name like X" — not a value or a file.

## Tasks

Each task is a self-contained directory under `tasks/<id>/`:

```
tasks/<id>/task.toml     stages, result_schema, [verifier], optional artifact_key
tasks/<id>/verifier.py   the pytest verifier (BENCH_RESULT / BENCH_FIXTURES / BENCH_OUTPUT)
tasks/<id>/inputs/       files staged into the sandbox; also readable by the verifier
tasks/<id>/expected/     verifier-only ground truth; NEVER staged to the agent
```

A stage's `[[stages.files]]` may stage a file from `inputs/` (its `src` is confined to `inputs/` at
load time, so a precomputed answer in `expected/` can never leak). A task whose deliverable is a
**file** sets `artifact_key` to the result property naming the file the agent exported via
`download_file`; the harness downloads that artifact and hands its bytes to the verifier as
`BENCH_OUTPUT`. Every verifier runs in its own ephemeral `uv` env (pytest installed automatically; a
verifier needing third-party packages lists them under `[verifier].deps`), so the harness itself ships
no Python — the only Python in the repo is the per-task verifiers and fixtures, each isolated per run.

A stage's `text` may inline a fixture's text content with a `{{file:<relpath>}}` placeholder (path
confined to the task dir) — useful for small tabular inputs when the target provider can't accept a
staged file part (e.g. the Anthropic-compatible Kimi gateway rejects all file/document blocks).

A task that grades **backend state** declares `[state].rest` — a list of relative `/api/…` GET paths.
After the run the harness snapshots each (with the privileged client) into `BENCH_STATE` along with
the run's ordered tool calls (`{name, input}`), so the isolated verifier can assert what the agent
*did to Archestra* without ever touching the backend itself. State paths and stage text may use the
runtime placeholders `{{cell}}` (a per-cell unique slug, so mutating tasks don't collide across a
multi-model matrix on one backend) and `{{agent_id}}`, substituted at run time.

## Environments

An environment is one `envs/<id>.toml` declaring `id` / `name`, an `[agent]` (name + system prompt),
the `[[skills]]` surface (each a pinned web ref `{repo, path, ref}` — `ref` slash-free), the
`[[mcps]]` remote servers (`{name, server_url}` — registered by URL, no auth), `tasks` (a list of
task-dir ids, globally unique across envs), and an optional `tools` allow-list of extra
`archestra__*` short names. By default the agent may *use* skills but is barred from mutating the
skill library (`create_skill`/`update_skill` are stripped, and a surviving one aborts the run); an
env that lists such a tool in `tools` keeps it, so only an env that opts in can author skills. An
optional `share_backend = true` lets all of an env's lanes share one backend (seeded once) — only safe
for envs whose tasks never mutate shared backend state; a mutating env stays isolated (the default), a
fresh backend per lane. Add a new environment by dropping another `envs/*.toml` — no code change.

`basic` ships all skills from `anthropics/skills` + `openai/skills`, three public no-auth remote MCPs
(DeepWiki, Microsoft Learn, Context7) as a realistic surface, `share_backend = true` (its tasks are
read-only against backend state), and six tasks —

- `pi-gif-zip` — estimate π by Monte-Carlo, render an animated GIF, invert its colors, zip and export
  it; the verifier asserts a valid zip containing a valid GIF (sandbox + file output).
- `crypto-price` — fetch the BTC and SOL price at a timestamp from Yahoo Finance in the sandbox and
  report their ratio (BTC/SOL); the verifier derives the expected ratio from recorded ground truth
  and checks it within tolerance.
- `median-salary` — compute the median of the salary column of a CSV inlined into the prompt (via a
  `{{file:…}}` placeholder); the verifier recomputes from the same fixture.
- `nitpicker-version` — report the latest `nitpicker` crate version as of a date; the verifier checks
  against recorded ground truth.
- `github-stars` — fetch the current star count of `archestra-ai/archestra` from the GitHub API; the
  verifier fetches the live `stargazers_count` and accepts the answer within a small tolerance (the
  count grows without bound, so there is no fixed offline fixture).
- `lena-png-size` — report the size in KiB (floored) of scikit-image's pinned `lena.png`; the verifier
  checks against recorded ground truth.

`archestra-api` exercises Archestra's **own** management API (no skills/MCPs seeded — the built-in
tool and skill catalog is the subject under test; `tools = ["create_skill"]`) with two tasks —

- `author-skill` — author a skill bundling a Python script (turn 1), then load and run it to compute
  an answer (turn 2); the verifier confirms via `BENCH_STATE` that the skill exists with a bundled
  file *and* a `run_command` executed its mounted `/skills/<name>` path, and that the answer is right.
- `letter-count` — count how many of the agent's tools + the instance's skills have a name containing
  the letter 'a' exactly three times; the verifier recomputes the count from the snapshotted
  `/api/agents/<id>/tools` + `/api/skills`, so there is no hardcoded answer.

## Lifecycle: fresh backend over shared infra

The harness does not run its own Tilt stack. It reuses the developer's already-running stack's
shared Postgres and Dagger code-runtime engine, and stands up only what must be isolated per env: a
fresh database (migrated from scratch) plus a second backend **process** on a new port. The backend
reads `process.env` directly, so benchmark overrides (fresh DB URL, new API/metrics ports, shared
Dagger host) take effect without a git worktree, a second Tilt, or any edit to `platform/.env`. The
second backend runs the already-built `dist/server.mjs` the main stack keeps fresh, so it never
starts a competing `tsdown --watch`. Teardown always runs: the backend process group is killed and
the benchmark database is dropped.

## Outcomes

Each (env, task, provider, model) cell resolves to exactly one outcome:

- `passed` / `failed` — a well-formed result was submitted and the verifier accepted / rejected it.
- `format_failed` — the agent submitted but never matched the schema within the attempt budget.
- `no_submission` — the run finished without ever calling `submit_result`.
- `agent_error` — the chat run errored before a result could be graded (an `infra:`-prefixed
  `agent_error` is a backend/boot failure for that lane, not a model failure — sibling lanes continue).

## Run

The harness is a single Rust binary, `archestra-bench`, with three subcommands: `benchmark` (run the
eval), `analyze` (turn a finished run into a recommendations report), and `full` (do both).

```bash
cargo build --release            # target/release/archestra-bench

# benchmark: every env x task x lane in lanes.toml
archestra-bench benchmark
archestra-bench benchmark --env basic --task median-salary --lanes kimi
# lanes run concurrently; each carries its own gateway + key (from lanes.toml):
OPENROUTER_API_KEY=... KIMI_API_KEY=... ZAI_API_KEY=... \
  archestra-bench benchmark --env basic --lanes minimax,kimi,glm     # 3 lanes -> 3 workers

# analyze a finished run into a report (map = per-trajectory summary lane, reduce = repo-grounded lane):
archestra-bench analyze --run-dir experiments/<id> --map kimi --reduce glm

# both at once: a fresh run, then its analysis
archestra-bench full --env basic --lanes kimi --map kimi --reduce glm
```

`--env` and `--task` each accept one name or a comma-separated list (default: all). A **lane** is a
named `(provider, model)` endpoint defined in `lanes.toml`; the sweep is `env x lane`. Each `[[lane]]`
carries a unique `name` (the selection handle), `provider` (`anthropic`/`openai`/`gemini`/`openrouter`),
`model`, an optional `base_url` (e.g. an Anthropic-compatible gateway), and an optional `api_key_env`
(default `<PROVIDER>_API_KEY`) — so two lanes can share a provider through different gateways/keys. The
`--lanes` flag selects lane names from the catalog (default: every lane), so you can define many and run
one; `--lanes-file` overrides the catalog path. `--max-workers` runs that many lanes concurrently
(default: one worker per selected lane, capped at 4); tasks within a lane stay serial. On `benchmark`,
`--run-dir` overrides the artifact directory (default `archestra-bench/experiments/<timestamp>/`,
gitignored) and `--out` writes the markdown report to a file instead of stdout; `full` always starts a
fresh run dir. `analyze`/`full` resolve `--map`/`--reduce` against the same `lanes.toml` and autodetect
the repo to crawl from the run dir (override with `--explore-root`).

Each run directory contains `config.json`, `aggregate.json`, a `<env>.backend.log` per shared env (or
`<env>__<lane>.backend.log` per isolated lane), and an `<env>/<task>__<lane>/` subdirectory per cell
(`<lane>` is the lane's name from lanes.toml) with `trajectory.jsonl` (the chat stream
coalesced into message-level records — `assistant_text` / `tool_call` / `tool_output` / `finish` /
`token_usage`, plus `error` / `parse_error` / `tool_call_partial` on failures or interrupted streams —
not the raw per-token SSE chunks), `run.json`,
`submission.json` (the accepted bytes), `artifact.bin` (a downloaded file artifact, when any),
`state.json` (the `BENCH_STATE` snapshot, when any), and `verifier.stdout.txt` / `verifier.stderr.txt`.

## Prerequisites

- A running Archestra dev stack (`tilt up` with `ARCHESTRA_CODE_RUNTIME_ENABLED=true`) providing the
  shared Postgres (host-reachable on `localhost:5432`) and the Dagger engine (`tcp://127.0.0.1:1234`),
  with the backend built (`dist/server.mjs`).
- A real provider key in the environment for each lane you run (e.g. `OPENROUTER_API_KEY`,
  `KIMI_API_KEY`, `ZAI_API_KEY`; see each lane's `api_key_env` in `lanes.toml`).
- A Rust toolchain to build `archestra-bench`, and local `uv` for the ephemeral verifier environments.

## Checks

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                    # harness + analyzer unit/integration tests (no live backend)
cargo deny check
```
