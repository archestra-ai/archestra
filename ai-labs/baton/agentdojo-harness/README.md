# agentdojo-harness

Runs the [baton-core](../baton-core) information-flow policy engine as a
tool-call-veto defense inside [AgentDojo](https://github.com/ethz-spylab/agentdojo),
the prompt-injection benchmark. Baton never reads the injected text: it tracks
which sources a conversation's context came from (a per-turn label fold) and
blocks tool calls whose contract the folded context cannot satisfy.

## Layout

- `../baton-check` — stateless Rust oracle over baton-core: one JSON request
  (contracts + episode so far + proposed call) in on stdin, one decision out
  on stdout. Built automatically on first use (`cargo build --release`), or
  point `BATON_CHECK_BIN` at a binary.
- `src/baton_dojo/defense.py` — `BatonToolsExecutor`, a drop-in replacement
  for AgentDojo's `ToolsExecutor`: consults the oracle before executing each
  tool call the LLM emits; blocked calls come back on the normal tool-error
  channel (`Blocked by baton policy: …`) and are never executed. Stateless —
  the episode is re-derived from the message history on every call.
- `contracts/workspace.toml` — the policy as data: every suite tool labeled by
  its *source type* (never by whether a given result actually carries an
  injection — that is the benchmark's ground truth, and peeking is cheating).
  Readers of third-party text are `suspicious`, pure-state readers `trusted`,
  sinks require a `trusted` context.

## Commands

```sh
uv sync

# Deterministic, free, no LLM: replay every task's scripted ground truth
# through the gate under all three unknown-policies.
uv run baton-dojo replay --suite workspace

# The real benchmark, via OpenRouter (key from $OPENROUTER_API_KEY or
# ../../.env). Compare a defended and an undefended pipeline:
uv run baton-dojo bench --model openai/gpt-4o-mini-2024-07-18 --defense baton
uv run baton-dojo bench --model openai/gpt-4o-mini-2024-07-18 --defense none

# Narrow a run: subsets, attack, policy, log directory.
uv run baton-dojo bench --model openai/gpt-4o-mini-2024-07-18 \
  --user-tasks user_task_0 user_task_13 --injection-tasks injection_task_0 \
  --attack important_instructions --unknown-policy allow_with_audit --logdir runs
```

`bench` prints clean utility, utility under attack, attack success rate, and
the number of policy-blocked calls; per-episode JSON (including full message
logs) lands under `--logdir`. Note the `important_instructions` attack
addresses the model by name and needs a model id AgentDojo knows (e.g. the
dated `openai/gpt-4o-mini-2024-07-18`); the `…_no_model_name` attack variant
works with any model id.

## Reading the replay report

`replay` is the gate that needs no model and no spend. Hard-asserted (exit 1,
on the `deny` table): every scripted injection ground truth blocks at or
before its first sink, clean flows stay permitted, and two evaluations agree.
Everything else is reported, not asserted — most importantly the benign tasks
the policy blocks.

That trade-off is the experiment's honest premise, not a bug: with
source-type labels, a benign "search my emails, then send one" and a poisoned
version of it are *identical in label space*. A trusted-only sink policy
blocks both. On workspace v1.2.2 that means: 6/6 scripted attacks blocked,
23/40 benign tasks untouched (read-only), 17/40 blocked at their sink — the
utility price of trust-only enforcement. Also note every sink-bearing
workspace ground truth reads a suspicious source first, so the clean-flow
assertion is currently vacuous there, and the three unknown-policy tables are
identical because the table annotates all 24 tools (nothing Unknown ever
enters the fold — the policies only separate under sparse annotation).

The dimension that *could* split benign sends from exfiltration is audience
(who may read the context vs. who the call exposes it to). That needs
per-datum audience data, which neither the wire format nor this table carries
yet — it is the headline follow-up, and it is data-plus-protocol work, not a
new engine.

## Adding a suite

Write `contracts/<suite>.toml` covering every tool of the suite (the harness
cross-checks and fails on drift — under `unknown_policy=deny` an unlisted
tool blocks outright, so gaps must be explicit), mark the sink tools'
`requires_trust` and `recipients_arg`, and run
`baton-dojo replay --suite <suite>`.
