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
            saving the streamed trajectory
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
`BENCH_OUTPUT`. A verifier needing third-party packages lists them under `[verifier].deps` (installed
into an ephemeral uv env); a no-dep verifier runs under the harness interpreter.

A stage's `text` may inline a fixture's text content with a `{{file:<relpath>}}` placeholder (path
confined to the task dir) — useful for small tabular inputs when the target provider can't accept a
staged file part (e.g. the Anthropic-compatible Kimi gateway rejects all file/document blocks).

## Environments

An environment is one `envs/<id>.toml` declaring `id` / `name`, an `[agent]` (name + system prompt),
the `[[skills]]` surface (each a pinned web ref `{repo, path, ref}` — `ref` slash-free), the
`[[mcps]]` remote servers (`{name, server_url}` — registered by URL, no auth), and `tasks` (a list
of task-dir ids, globally unique across envs). Add a new environment by dropping another
`envs/*.toml` — no code change.

`basic` ships today: all skills from `anthropics/skills` + `openai/skills`, three public no-auth
remote MCPs (DeepWiki, Microsoft Learn, Context7) as a realistic surface, and three tasks —

- `pi-gif-zip` — estimate π by Monte-Carlo, render an animated GIF, invert its colors, zip and export
  it; the verifier asserts a valid zip containing a valid GIF (sandbox + file output).
- `crypto-price` — fetch BTC/SOL price at a timestamp from Yahoo Finance in the sandbox; the verifier
  checks both values against recorded ground truth within tolerance.
- `median-salary` — compute the median of the salary column of a CSV inlined into the prompt (via a
  `{{file:…}}` placeholder); the verifier recomputes from the same fixture.

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

Each (env, task, model) cell resolves to exactly one outcome:

- `passed` / `failed` — a well-formed result was submitted and the verifier accepted / rejected it.
- `format_failed` — the agent submitted but never matched the schema within the attempt budget.
- `no_submission` — the run finished without ever calling `submit_result`.
- `agent_error` — the chat run errored before a result could be graded.

## Run

```bash
export ANTHROPIC_API_KEY=<key>

uv run run.py                                          # every env x every task x default model
uv run run.py --env basic --task median-salary --model claude-sonnet-4-6
# benchmark a non-Anthropic model via an Anthropic-compatible gateway:
ANTHROPIC_API_KEY=$KIMI_API_KEY uv run run.py --env basic \
  --provider anthropic --base-url https://api.kimi.com/coding --model kimi-for-coding
```

`--env`, `--task`, and `--model` each accept one name or a comma-separated list. `--env` defaults to
all environments; `--task` defaults to all tasks in the selected envs and filters by task id.
`--provider` defaults to `anthropic`; `--base-url` overrides its endpoint. `--run-dir` overrides the
artifact directory (default `archestra-bench/experiments/run_<id>/`, gitignored); `--out` writes the
markdown report to a file instead of stdout.

Each run directory contains `config.json`, `aggregate.json`, a `<env>.backend.log` per env, and an
`<env>/<task>__<model>/` subdirectory per cell with `trajectory.jsonl`, `run.json`, `submission.json`
(the accepted bytes), `artifact.bin` (a downloaded file artifact, when any), and
`verifier.stdout.txt` / `verifier.stderr.txt`.

## Prerequisites

- A running Archestra dev stack (`tilt up` with `ARCHESTRA_CODE_RUNTIME_ENABLED=true`) providing the
  shared Postgres (host-reachable on `localhost:5432`) and the Dagger engine (`tcp://127.0.0.1:1234`),
  with the backend built (`dist/server.mjs`).
- A real provider key in the environment (`ANTHROPIC_API_KEY`).
- Local `uv` for the harness and the ephemeral verifier environments.

## Checks

```bash
uv run --group dev ruff check .
uv run --group dev ty check
uv run --group dev pytest                 # harness behavior tests (no live backend needed)
```
