# trajectory-analyzer

Map-reduce analysis of archestra-bench trajectories. Each rollout's `trajectory.jsonl` is triaged by
a one-shot LLM call (map) into a structured judgment — four rubric grades (knowledge, reasoning,
instruction_following, env_ergonomics; 1–5 with a comment each), a reward-hacking flag, a verdict, and
evidence observations — then a repo-grounded [`nitpicker-agent`](https://github.com/arsenyinfo/nitpicker)
turns the rendered triages plus run metrics into a recommendations report (reduce).

The benchmarked model is fixed and out of our control; the report targets the surfaces we own — task
prompts, JSON result schemas, verifiers, env/skill configuration, the MCP tool surface, and the harness.

The reduce agent crawls `--explore-root` read-only, so point it at the **repository root**: the agent
then sees both the benchmark harness (`ai-labs/`) and the Archestra product it exercises (the
backend and MCP tool implementations), and cross-checks each issue against its real definition.

## Build

```sh
cargo build --release
```

## Run

```sh
GEMINI_API_KEY=… cargo run -- \
  --run-dir ../experiments/<run-id> \
  --map-model gemini-3-flash-preview --map-provider gemini \
  --reduce-model gemini-3-flash-preview --reduce-provider gemini \
  --explore-root ../..
```

Provider and model are fully configurable per phase (`--map-*` / `--reduce-*`). `--provider` is one of
`anthropic`, `gemini`, `openai`, `openrouter`; each reads its key from the environment
(`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`), overridable with
`--*-api-key-env`. Anthropic/Gemini/OpenAI accept a gateway `--*-base-url`.

- `--run-dir` — an `experiments/<id>` dir holding `<env>/<task>__<lane>/{trajectory.jsonl,run.json}`.
- `--explore-root` — repository the reduce agent crawls for grounding (default `.`); pass the repo root.
- `--out` — report path (default `<run-dir>/trajectory_analysis_<ts>.md`).
- `--max-turns` — reduce agent turn cap (default 50).
- `--concurrency` — max concurrent map calls (default 6).

Progress renders as a live map bar and a reduce spinner (turns / tool calls / subagents). When stderr
is not a TTY (piped or CI) the live bars are hidden and the status lines (rollout count, map failures,
report path) fall back to plain stderr. Set `RUST_LOG=info` to also surface the agent's internal logs.

Each rollout's rendered trajectory (the exact markdown fed to the map phase) is written next to its
source as `<env>/<task>__<lane>/trajectory.md`. The structured triage records are written to
`<run-dir>/trajectory_rubrics_<ts>.jsonl` (one record per line, failures first; rollouts whose map
call failed are absent) and the markdown rendered from them to `<run-dir>/trajectory_analyses_<ts>.md`,
both before the reduce phase starts, so a reduce failure never discards the per-rollout triages.
The Claude-skill pipeline (`.claude/skills/archestra-dev-bench-analysis`) emits the same record shape
as `trajectory_rubrics_claude_<ts>.jsonl`; a golden fixture under `tests/fixtures/triage_golden/`
pins the two renderers to byte-identical output.

Browse runs and rubric records interactively with `archestra-bench dashboard
[--experiments-dir <dir>] [--port <port>]` — a local, read-only web UI over `experiments/`.
