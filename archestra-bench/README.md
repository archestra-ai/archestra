# archestra-bench

A benchmark / trajectory generator for Archestra's core agentic features. Tasks are grouped into
**environments** (`envs/<id>.toml`): a bundle of web-pinned skills, MCP fixtures, and a single agent,
plus the tasks that run against that surface. Each environment boots its own fresh, isolated
Archestra backend, seeds its fixtures, drives agentic chat sessions to solve its tasks, grades the
submitted answers out of band, and tears the instance down. Results aggregate by environment and by
task.

## Protocol

```
start the harness-owned benchmark MCP (submit_result) in-process
  -> for each environment:
       boot a fresh backend on a new port over a fresh, migrated database
         (reusing the dev stack's shared Postgres + Dagger engine)
       -> seed: provider key + models, the env's web-pinned skills, its MCP fixtures,
                the benchmark MCP; create the env's agent and lock its tool surface
       -> for each task x model:
            drive the task's ordered conversation stages (user asks X -> corrects to Y),
            saving the streamed trajectory
       -> read the submitted result from the benchmark MCP and verify its bytes out of band
       -> drop the database + kill the backend
  -> aggregate by env and by task, write artifacts
```

The agent hands in its answer by calling the benchmark MCP's `submit_result` tool. That tool checks
only the **format** of the answer (against the task's JSON-schema) and, on a malformed payload,
returns a structured error so the model self-corrects within its own tool loop — bounded by a small
attempt budget. Real correctness is checked **out of band** by the task's vendored verifier, which
never enters the sandbox or the MCP, so the agent can never read or game it.

## Environments

An environment is one `envs/<id>.toml` file declaring:

- `id` / `name` and an `[agent]` (name + system prompt) — the single agent under test.
- `[[skills]]` — the env's skill surface, each a web ref `{repo, path, ref}`. Skills are imported
  from GitHub pinned to a commit/branch/tag (`ref` is required); nothing is vendored locally.
- `[[mcps]]` — optional extra MCP fixtures available to the agent.
- `[[tasks]]` — the tasks (stages, `result_schema` or `result_schema_file`, verifier) that run in
  this env. Task ids are globally unique across all envs.

Two ship today:

- `optimization` — the `bike-rebalance` SkillsBench optimization task; the agent computes in the
  sandbox and submits its `report.json` inline. Its four skills are pinned from
  `github.com/benchflow-ai/skillsbench`; SCIP-backed verifier with a fidelity oracle (`--gate-only`).
- `basics` — `multistage-demo` (ask the sum, then correct to the product) and `list-stats` (read a
  staged JSON file and compute stats). No skills or MCPs; exercises the multi-stage + submit_result +
  verify path with zero web dependencies.

Add a new environment (e.g. scientific, marketing, consumer) by dropping another `envs/*.toml` — no
code change.

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

uv run run.py                                            # every env x every task x default model
uv run run.py --env optimization --model claude-sonnet-4-6
uv run run.py --env basics --task multistage-demo --model claude-sonnet-4-6,other-model
uv run run.py --env optimization --gate-only            # fidelity gate, no model needed
```

`--env`, `--task`, and `--model` each accept one name or a comma-separated list. `--env` defaults to
all environments; `--task` defaults to all tasks in the selected envs and filters by task id;
`--gate-only` skips tasks that declare no oracle. `--provider` defaults to `anthropic` (the key is
read from `ANTHROPIC_API_KEY`). `--run-dir` overrides the artifact directory; by default artifacts go
under `archestra-bench/experiments/run_<id>/` (gitignored). `--out` writes the markdown report to a
file instead of stdout.

Each run directory contains `config.json`, `aggregate.json`, a `<env>.backend.log` per env, and an
`<env>/<task>__<model>/` subdirectory per cell with:

- `trajectory.jsonl` — parsed chat stream events plus ignored/parse-error records and errors.
- `run.json` — metadata: env/model/conversation ids, outcome, finish reason, token/tool counts,
  format attempts, verifier result, artifact paths.
- `submission.json` — the accepted result bytes (when one was submitted).
- `verifier.stdout.txt` / `verifier.stderr.txt` — verifier process output (when verification ran).

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
```

## Smoke

A real end-to-end run of the simplest environment (boot → seed → multi-stage chat → submit → verify).
Needs the dev stack up and a funded key; it exits non-zero unless the run passes:

```bash
export ANTHROPIC_API_KEY=<key>
uv run run.py --env basics --task multistage-demo --model claude-haiku-4-5-20251001
```
