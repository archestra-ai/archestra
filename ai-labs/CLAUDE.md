# Authoring bench tasks

Conventions for writing/editing a `tasks/<id>/` task. Mechanics (env-var contract, `[state].rest`,
file layout, lifecycle) live in `../README.md` -- this file is the discipline, not the plumbing.

## The prompt is a real user's ask

- Read like a coworker's request, not a spec sheet. No mention of the sandbox, `run_command`,
  `search_tools`, `/home/sandbox` paths, or "the verifier".
- Don't spoon-feed the approach or name the skill/tool that solves it -- finding the right tool is
  itself a key capability under test, so naming it hands the model the answer. A prompt names only the
  **delivery-protocol** tools the harness grades through -- `submit_result` (always) and `download_file`
  (file-output tasks) -- never a task-solving tool (`create_skill`, `load_skill`, `list_skills`, a
  skill, a sandbox command). State the goal ("author a skill that…", "use that skill to…"); let the
  agent discover how.
- Never reveal the agent is inside a benchmark/eval/harness. No "benchmark", "eval", "test", "graded",
  or "fixture" language on any agent-facing surface -- the prompt **and** the skills/files it loads. A
  real user would never say "the benchmark blobs"; they have a blob and want it decoded.
- No trap warnings ("be careful to…", "make sure exactly N"). No bold/emphasis on the checked
  quantity: emphasis telegraphs the oracle and hands the model the answer shape.
- State the deliverable as a preference ("I'd like a 60-frame GIF…"), not a contract to satisfy.

## The verifier is a strict oracle

- Clean-or-fail. Extract the submitted value strictly; never coerce or salvage a stringified /
  wrapped result. A format the model got wrong is a real capability signal, not something to repair.
- Check the genuine artifact or mechanism, not a memorizable proxy (verify the actual GIF frames; do
  not accept a reported π a model can recite from memory).
- `expected/` is verifier-only ground truth and is NEVER staged to the agent. Prefer recomputing the
  answer from fixtures over hardcoding it.
- Assertion messages stay diagnostic for triage -- but the model never reads them, so don't soften
  the check to make a nicer message.

## Difficulty floor

If a weak model scores 100% on a task, it is leaking or trivial: de-clue the prompt or strengthen the
oracle. Solving it should require the work, not pattern-matching the phrasing.

## Running against a prod image (benchmark CI)

The daily benchmark (`.github/bench/`, see its README) runs this harness inside the deployed
platform image instead of the dev repo. Three knobs make that work, all defaulting to today's local
behavior when unset:

- `--platform-dir` / `ARCHESTRA_BENCH_PLATFORM_DIR` — the platform dir is `/app` in the prod image,
  not `<repo>/platform`.
- `ARCHESTRA_BENCH_MIGRATE_CMD` — the prod image has no pnpm; it runs `drizzle-kit migrate` directly.
- The Dagger runner host + CLI bin arrive via **process env**, not `/app/.env`: `build_backend_env`
  force-overwrites those two keys, so `.env` can't steer them (it seeds from `std::env::vars()`, so
  other container env vars — feature flags — do flow through).

Gotchas: the bench resolves its Postgres from `ARCHESTRA_BENCH_DATABASE_URL` and creates its own
per-run DB on it. The sandbox (`run_command`) is gated only by a valid Dagger host
(`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`); the `basic` env needs no other env to expose Agent
Skills and Environments. The prod image runs `NODE_ENV=production`, where better-auth
hard-exits on its default secret — set `ARCHESTRA_AUTH_SECRET` (the entrypoint generates a throwaway
one per run; the DB is fresh and dropped each run, so the value never matters).

## Skills are pinned, not live

Benchmark-owned skills are imported by pinned GitHub commit SHA in `../envs/basic.toml`, not from the
working tree. After editing a skill under `../skills/`, commit + push, then repin its `ref`. Edits do
not take effect until repinned.
