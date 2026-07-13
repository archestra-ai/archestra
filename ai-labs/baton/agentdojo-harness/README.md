# agentdojo-harness

Runs the [baton-core](../baton-core) information-flow policy engine as a
tool-call-veto defense inside [AgentDojo](https://github.com/ethz-spylab/agentdojo),
the prompt-injection benchmark. Baton never reads the injected text: it tracks
which sources a conversation's context came from (a per-turn label fold) and
blocks tool calls whose contract the folded context cannot satisfy.

## Layout

- `../baton-check` — stateless Rust policy check over baton-core: one JSON
  request (contracts + episode so far + proposed call) in on stdin, one
  decision out on stdout. Built automatically on first use
  (`cargo build --release`), or point `BATON_CHECK_BIN` at a binary.
- `src/baton_dojo/defense.py` — `BatonToolsExecutor`, a drop-in replacement
  for AgentDojo's `ToolsExecutor`: consults baton-check before executing each
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

# The benchmark, via OpenRouter (key from $OPENROUTER_API_KEY or
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

### Running sharded

AgentDojo runs one episode at a time, so a full suite is slow: the `workspace`
suite has 40 user tasks and 14 injections, so a full run is 40 clean + 40 × 14
attacked = 600 episodes per defense. But episodes are independent
and cached (`force_rerun=False`), so you can split the user tasks across
several `bench` processes writing to the *same* `--logdir`: each fills
different cells of the grid, cached cells are skipped, and a killed run just
resumes where it stopped.

```sh
# build baton-check once and pin it, so the shards don't each rebuild it
( cd ../baton-check && cargo build --release )
export BATON_CHECK_BIN="$PWD/../baton-check/target/release/baton-check"

model=openai/gpt-4o-mini-2024-07-18
for lo in 0 10 20 30; do                       # 4 shards of 10 user tasks each
  tasks=$(seq $lo $((lo + 9)) | sed 's/^/user_task_/')
  uv run baton-dojo bench --model "$model" --defense baton \
    --user-tasks $tasks --logdir runs > "runs/shard_$lo.log" 2>&1 &
done
wait
```

Each shard prints only its own slice. To get whole-suite numbers, run one
plain `bench` over all tasks afterwards — every episode is cached, so it just
reads the grid and prints the totals. (Run the loop again with `--defense none`
for the undefended baseline; those shards spawn no baton-check.)

## The trust-only limitation

With source-type labels, a benign "search my emails, then send one" and a
poisoned version of it are *identical in label space*. A trusted-only sink
policy blocks both — that trade-off is the experiment's honest premise, not a
bug. Concretely on the workspace suite: read-only tasks pass untouched, but a
benign task that reads a suspicious source before a sink is blocked at that
sink too — the utility price of trust-only enforcement. Note also that the
three unknown-policies behave identically here, because the table annotates
all 24 tools: nothing Unknown ever enters the fold, so the policies only
separate under sparse annotation.

The dimension that *could* split benign sends from exfiltration is audience
(who may read the context vs. who the call exposes it to). That needs
per-datum audience data, which neither the wire format nor this table carries
yet — it is the headline follow-up, and it is data-plus-protocol work, not a
new engine.

## Adding a suite

Write `contracts/<suite>.toml` covering every tool of the suite (the harness
cross-checks and fails on drift — under `unknown_policy=deny` an unlisted
tool blocks outright, so gaps must be explicit), mark the sink tools'
`requires_trust` and `recipients_arg`, then run a `bench` against it.
