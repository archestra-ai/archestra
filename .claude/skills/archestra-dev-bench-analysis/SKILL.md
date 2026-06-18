---
name: archestra-dev-bench-analysis
description: Map-reduce a finished archestra-bench run into a Tier-1/Tier-2 improvement report using Claude subagents (same analysis as the Rust analyzer, no API key).
argument-hint: "[run dir]"
---

# Archestra bench trajectory analysis

Map-reduce a finished `archestra-bench` run into a recommendations report, using Claude subagents
for the judgment. The deterministic half (render + metrics + manifest) is done by the Rust
`archestra-bench prepare` subcommand, so this skill reuses the analyzer's exact rendering, metrics,
and ordering — it does not re-implement them. Mirrors `archestra-bench/analyzer` (map = per-rollout
triage; reduce = repo-grounded Tier-1/Tier-2 report); see `archestra-bench/analyzer/README.md`.

The exact map/reduce prompt text lives in `reference/prompts.md` (this skill's directory) — read it
and fill the placeholders; do not paraphrase it.

## 1. Resolve the run dir (absolute)

If `$ARGUMENTS` names a run dir, use it; otherwise pick the newest under
`archestra-bench/experiments/` (the `YYYYMMDD_HHMMSS` names sort chronologically). Resolve it to an
**absolute** path — `realpath` it — so every path in the manifest is absolute and readable from any
subagent's working directory:

```
realpath "$( [ -n "<ARG>" ] && echo "<ARG>" || ls -1d archestra-bench/experiments/*/ | sort | tail -1 )"
```

State which dir you chose. Use this absolute path as `<RUN_DIR>` everywhere below.

## 2. Prepare (deterministic, Rust)

Run from the repo root:

```
cargo run -q --manifest-path archestra-bench/cli/Cargo.toml -- prepare --run-dir <RUN_DIR>
```

stdout is a JSON manifest `{ metrics_block, rollouts: [{ id, outcome, outcome_summary,
trajectory_md }] }`, already failures-first. It renders each rollout's `trajectory.md`. Parse it; if
the command errors (e.g. a malformed trajectory aborts with `path:line`), surface the error and
stop. Capture a timestamp once for the output filenames: `date +%Y%m%d-%H%M%S`.

## 3. Map — one triage subagent per rollout

For each `rollouts[i]`, launch a subagent (general-purpose, read-only file tools) with the **MAP**
prompt from `reference/prompts.md`, filling `{ROLLOUT_ID}`=`id`, `{OUTCOME_SUMMARY}`=`outcome_summary`,
`{TRAJECTORY_MD_PATH}`=`trajectory_md`. The subagent reads its own trajectory and returns a short
triage (≤6000 chars). Launch them in parallel batches (~8 at a time) so file contents stay in the
subagents' contexts, not yours. Keep each result paired with its rollout `id` and `outcome`.

Use **`model: sonnet`** for these map subagents — per-rollout triage is a cheap, bounded read, and a
run has dozens of rollouts, so Sonnet keeps the map phase fast and inexpensive. Reserve the stronger
model for the reduce phase (step 5), where the cross-rollout synthesis and repo grounding live.

## 4. Assemble the analyses doc

Build the document in **manifest order** (do not reorder):

```
<metrics_block>

# Per-trajectory analyses

## <id> — <outcome>

<triage>

## <id> — <outcome>
...
```

If any triage exceeds 6000 chars, truncate it and append `\n[analysis truncated]` (parity with the
Rust analyzer). `Write` it to `<RUN_DIR>/trajectory_analyses_claude_<ts>.md` **before** the reduce
step — a reduce failure must never discard the map work.

## 5. Reduce — repo-grounded report

Adopt the **REDUCE system guidance** from `reference/prompts.md` as your framing, then carry out the
**REDUCE task message** (fill `{ANALYSES_DOC_PATH}` with the file from step 4, `{RUN_DIR}` absolute,
`{BACKEND_LOG_PATHS}` with `<RUN_DIR>/*.backend.log`). Crawl `platform/` (Tier 1) and
`archestra-bench/` (Tier 2) to ground every finding in `file:line`; fan out one crawler subagent per
issue/subsystem using the **REDUCE crawler** prompt. Before citing a surprising map claim, open the
rollout's raw `trajectory.md` and confirm it.

**Hard rule:** the backend-log files (`<RUN_DIR>/*.backend.log`, e.g. `basic.backend.log`) are
~tens of MB. Never `Read`/`cat` them (yours or a subagent's) — only capped grep, e.g.
`grep -n -m 50 -F '<pattern>' <RUN_DIR>/basic.backend.log`.

`Write` the report to `<RUN_DIR>/trajectory_analysis_claude_<ts>.md` (same `<ts>` as step 4).

## 6. Report

Tell the user both output paths and a one-line headline (overall pass rate + the top Tier-1 finding).
