---
name: archestra-dev-bench-analysis
description: Map-reduce a finished archestra-bench run into a Tier-1/Tier-2 improvement report using Claude subagents (same analysis as the Rust analyzer, no API key).
argument-hint: "[run dir]"
---

# Archestra bench trajectory analysis

Map-reduce a finished `archestra-bench` run into a recommendations report, using Claude subagents
for the judgment. The deterministic half (render + metrics + manifest) is done by the Rust
`archestra-bench prepare` subcommand, so this skill reuses the analyzer's exact rendering, metrics,
and ordering — it does not re-implement them. Mirrors `ai-labs/analyzer` (map = per-rollout
triage; reduce = repo-grounded Tier-1/Tier-2 report); see `ai-labs/analyzer/README.md`.

The subagent fan-out runs through the **native Workflow tool** — two scripts under this skill's
`workflows/` directory drive the map and crawl phases, so the orchestrator never hand-batches Agent
calls and the per-rollout triages never flow through its context. Calling those scripts here is your
explicit opt-in to Workflow. The exact map/reduce prompt text lives in `reference/prompts.md` (this
skill's directory) — `bin/prepare.sh` extracts the MAP block automatically; you still read the
**REDUCE** sections verbatim in step 4. Do not paraphrase those prompts.

`<SKILL_DIR>` below is this skill's absolute directory (the one containing this file).

## 1. Prepare (deterministic: dir resolution + Rust `prepare` + arg shaping)

Run the helper (from anywhere — it derives the repo root). Pass a run dir, or omit it to pick the
newest under `ai-labs/experiments/`:

```
<SKILL_DIR>/bin/prepare.sh "$ARGUMENTS"
```

It resolves the run dir to an absolute path, runs `archestra-bench prepare` (failures-first manifest;
**fail-fast** — if it exits non-zero, surface the printed `path:line` error and stop), and writes
under `<RUN_DIR>/_prep_claude/`: `manifest.json`, `metrics.md`, `order.tsv` (`idx<TAB>id<TAB>outcome`,
manifest order), one pre-rendered triage prompt per rollout under `prompts/<NN>.txt`, and
`map-args.json` (small, ready-to-pass `args` for the map workflow). It prints a
`KEY=value` summary — capture `RUN_DIR`, `TS`, `TRIAGE_DIR`, `MAP_ARGS`, `ANALYSES_DOC`,
`REPORT_DOC` — then the metrics block. **State which `RUN_DIR` it chose.**

## 2. Map — one triage workflow

`Read` the `MAP_ARGS` file (`map-args.json`) and pass its JSON as `args` to the Workflow tool with
`scriptPath: <SKILL_DIR>/workflows/map.mjs`. The file is small by design — `triageDir`, `promptsDir`,
and the `rollouts` array (`{idx,id}`, manifest order); the filled triage prompts live on disk under
`promptsDir`, so the bulk never flows through your context. The workflow fans out one **Sonnet**
triage agent per rollout (auto-batched at the concurrency cap — no manual 8-at-a-time loop); each
reads its pre-rendered prompt (`<promptsDir>/<NN>.txt`) and the trajectory it points to, then `Write`s
its judgment — a single JSON object (rubric grades, reward-hacking flag, observations) — to
`<TRIAGE_DIR>/<NN>.json` (zero-padded `idx`). It returns `{written, total}`; if `written < total`,
step 3's validator will name the missing indices. Sonnet is deliberate — triage is a cheap bounded
read; reserve the stronger model for the reduce synthesis.

## 3. Validate + assemble (deterministic, in this loop)

Run the renderer — it validates every `<TRIAGE_DIR>/<NN>.json` against `order.tsv`, stamps
rollout/outcome from `order.tsv` (never from model output), writes the rubrics JSONL
(`<RUN_DIR>/trajectory_rubrics_claude_<TS>.jsonl`) and the analyses doc (truncation parity with the
Rust analyzer included), and prints both paths as `KEY=value`:

```
node <SKILL_DIR>/bin/render-triage.mjs <RUN_DIR> <TS>
```

If it exits non-zero, it lists the invalid/missing indices (and any extra/stale files) on stderr:
delete the extra files, re-run the map workflow with a `rollouts` subset containing only those
indices — filter `map-args.json` with jq, e.g.
`jq '.rollouts |= map(select(.idx == 3 or .idx == 7))' <MAP_ARGS>` — then re-run
`render-triage.mjs`. Do this **before** the reduce step — a reduce failure must never discard the
map work.

## 4. Reduce — repo-grounded report

`Read` the analyses doc (`ANALYSES_DOC`). Adopt the **REDUCE system guidance** from
`reference/prompts.md` as your framing, then carry out the **REDUCE task message** (fill
`{ANALYSES_DOC_PATH}` with `ANALYSES_DOC`, `{RUN_DIR}` absolute, `{BACKEND_LOG_PATHS}` with
`<RUN_DIR>/*.backend.log`).

Ground every finding in `file:line` across `platform/` (Tier 1) and `ai-labs/` (Tier 2) by
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

It returns `[{ label, evidence }]` (`.filter(Boolean)` it — a hard-failing crawler yields a null) —
the grounding you synthesize the report from. Before citing a surprising map claim, open the
rollout's raw `trajectory.md` and confirm it.

**Hard rule:** the backend-log files (`<RUN_DIR>/*.backend.log`, e.g. `basic.backend.log`) are
~tens of MB. Never `Read`/`cat` them (yours or a subagent's) — only capped grep, e.g.
`grep -n -m 50 -F '<pattern>' <RUN_DIR>/basic.backend.log`.

`Write` the report to `REPORT_DOC` (`<RUN_DIR>/trajectory_analysis_claude_<TS>.md`).

## 5. Report

Tell the user the output paths (analyses doc, rubrics JSONL, report) and a one-line headline
(overall pass rate + the top Tier-1 finding).
