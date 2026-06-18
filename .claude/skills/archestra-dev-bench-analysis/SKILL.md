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

The subagent fan-out runs through the **native Workflow tool** — two scripts under this skill's
`workflows/` directory drive the map and crawl phases, so the orchestrator never hand-batches Agent
calls and the per-rollout triages never flow through its context. Calling those scripts here is your
explicit opt-in to Workflow. The exact map/reduce prompt text lives in `reference/prompts.md` (this
skill's directory) — read it and pass it through verbatim; do not paraphrase it.

`<SKILL_DIR>` below is this skill's absolute directory (the one containing this file).

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
stop. Capture a timestamp once for the output filenames: `date +%Y%m%d-%H%M%S` (call it `<ts>`).
Create the triage scratch dir: `mkdir -p <RUN_DIR>/_triage_claude`.

## 3. Map — one triage workflow, not a manual batch loop

Read the **MAP** prompt block from `reference/prompts.md` verbatim (with its `{ROLLOUT_ID}`,
`{OUTCOME_SUMMARY}`, `{TRAJECTORY_MD_PATH}` placeholders intact). Then call the Workflow tool with
`scriptPath: <SKILL_DIR>/workflows/map.mjs` and `args`:

```
{
  "triageDir": "<RUN_DIR>/_triage_claude",
  "mapTemplate": "<the verbatim MAP block>",
  "rollouts": [ { "idx": 0, "id": "<id>", "outcome": "<outcome>",
                  "outcomeSummary": "<outcome_summary>", "trajectoryMd": "<trajectory_md>" }, ... ]
}
```

`rollouts` is the manifest `rollouts` array in order, with `idx` = its 0-based manifest index. The
workflow fans out one **Sonnet** triage agent per rollout (auto-batched at the concurrency cap — no
manual 8-at-a-time loop), each reads its own trajectory and `Write`s its triage (≤6000 chars) to
`<RUN_DIR>/_triage_claude/<NN>.md` where `<NN>` is the zero-padded `idx`. It returns
`{ written, total }`; if `written < total`, note which indices are missing a triage file before
continuing. Sonnet is deliberate here — triage is a cheap bounded read; reserve the stronger model
for the reduce synthesis (step 5).

## 4. Assemble the analyses doc (deterministic, in this loop)

The triage files are on disk; concatenate them in **manifest order** with bash (file→file, so the
triages never enter your context). From the repo root, with `<ts>` and the manifest from step 2:

```
RUN_DIR=<RUN_DIR>; TS=<ts>; T="$RUN_DIR/_triage_claude"; OUT="$RUN_DIR/trajectory_analyses_claude_$TS.md"
# write <metrics_block> to /tmp/_metrics.md first, and id/outcome rows (manifest order) to /tmp/_order.tsv as "idx\tid\toutcome"
{ cat /tmp/_metrics.md; printf '\n# Per-trajectory analyses\n'; \
  while IFS=$'\t' read -r idx id outcome; do f=$(printf '%s/%02d.md' "$T" "$idx"); \
    printf '\n## %s — %s\n\n' "$id" "$outcome"; \
    if [ "$(wc -m < "$f")" -gt 6000 ]; then head -c 6000 "$f"; printf '\n[analysis truncated]\n'; \
    else cat "$f"; printf '\n'; fi; \
  done < /tmp/_order.tsv; } > "$OUT"
```

Truncation parity with the Rust analyzer (`[analysis truncated]` past 6000 chars). This file is
written **before** the reduce step — a reduce failure must never discard the map work.

## 5. Reduce — repo-grounded report

`Read` the analyses doc from step 4. Adopt the **REDUCE system guidance** from `reference/prompts.md`
as your framing, then carry out the **REDUCE task message** (fill `{ANALYSES_DOC_PATH}` with the file
from step 4, `{RUN_DIR}` absolute, `{BACKEND_LOG_PATHS}` with `<RUN_DIR>/*.backend.log`).

Ground every finding in `file:line` across `platform/` (Tier 1) and `archestra-bench/` (Tier 2) by
fanning the crawlers out through the **crawl workflow**: derive one issue/subsystem per cluster from
the analyses doc, then call the Workflow tool with `scriptPath: <SKILL_DIR>/workflows/crawl.mjs` and
`args`:

```
{
  "repoRoot": "<repo root absolute>",
  "crawlerSystem": "<the verbatim REDUCE crawler system prompt from reference/prompts.md>",
  "issues": [ { "label": "run_command-target", "prompt": "<one issue to investigate>" }, ... ]
}
```

It returns `[{ label, evidence }]` — the grounding you synthesize the report from. Before citing a
surprising map claim, open the rollout's raw `trajectory.md` and confirm it.

**Hard rule:** the backend-log files (`<RUN_DIR>/*.backend.log`, e.g. `basic.backend.log`) are
~tens of MB. Never `Read`/`cat` them (yours or a subagent's) — only capped grep, e.g.
`grep -n -m 50 -F '<pattern>' <RUN_DIR>/basic.backend.log`.

`Write` the report to `<RUN_DIR>/trajectory_analysis_claude_<ts>.md` (same `<ts>` as step 4).

## 6. Report

Tell the user both output paths and a one-line headline (overall pass rate + the top Tier-1 finding).
