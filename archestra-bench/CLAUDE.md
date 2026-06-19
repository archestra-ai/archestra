# Authoring bench tasks

Conventions for writing/editing a `tasks/<id>/` task. Mechanics (env-var contract, `[state].rest`,
file layout, lifecycle) live in `../README.md` -- this file is the discipline, not the plumbing.

## The prompt is a real user's ask

- Read like a coworker's request, not a spec sheet. No mention of the sandbox, `run_command`,
  `search_tools`, `/home/sandbox` paths, or "the verifier". The only tool a prompt names is
  `submit_result` (the protocol requires it).
- Don't spoon-feed the approach or name the skill/tool that solves it -- discovering it is the task.
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

## Skills are pinned, not live

Benchmark-owned skills are imported by pinned GitHub commit SHA in `../envs/basic.toml`, not from the
working tree. After editing a skill under `../skills/`, commit + push, then repin its `ref`. Edits do
not take effect until repinned.
