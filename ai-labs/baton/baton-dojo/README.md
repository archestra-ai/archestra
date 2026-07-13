# baton-dojo

A Rust-native substrate for an [AgentDojo](https://github.com/ethz-spylab/agentdojo)-style
prompt-injection benchmark, wired directly to the in-process
[`baton-core`](../baton-core) information-flow policy engine.

This is the reusable core — **workspaces, tools, an OpenRouter agent loop, a
baton policy gate, and utility/security scoring abstractions**. It deliberately
ships no authored task catalog yet: you bring your own workspace and checks.

## Three-step authoring

```rust
use baton_dojo::{Agent, OpenRouter, Toolset};
use serde_json::json;

// 1. A workspace is any mutable struct.
let mut ws = Mailbox::seed();

// 2. Declare tools that read/mutate it (name, description, JSON-schema args, handler).
let tools = Toolset::<Mailbox>::new()
    .tool("read_inbox", "List all emails", json!({"type": "object", "properties": {}}),
          |ws, _args| Ok(json!(ws.emails)))
    .tool("send_email", "Send an email",
          json!({"type": "object",
                 "properties": {"to": {"type": "string"}, "body": {"type": "string"}},
                 "required": ["to", "body"]}),
          |ws, args| { ws.sent.push(Email::from_args(&args)?); Ok(json!({"status": "sent"})) })
    .finalize()?;                       // rejects duplicate tool names

// 3. Give the tools to an OpenRouter agent.
let model = OpenRouter::from_env("anthropic/claude-3.5-sonnet")?;
let run = Agent::new(&model).run(&mut ws, &tools, "Summarize my inbox").await?;
```

Run an example (each needs a key in `OPENROUTER_API_KEY` or `ai-labs/.env`):

```sh
cargo run -p baton-dojo --example workspace_demo     # trust: reading a suspicious inbox blocks a trusted-only send
cargo run -p baton-dojo --example recording_to_task  # audience: leaking an internal recording to a public issue is blocked
cargo run -p baton-dojo --example external_auditor   # audience: a mandated authority declassifies a send to the auditor
```

## AgentDojo, in Rust

AgentDojo is built from an agent, a tools runtime, a mutable **environment**, and
user/injection tasks. This crate provides that substrate natively:

| AgentDojo | here |
|---|---|
| environment (`TaskEnvironment`) | your own `W` — any mutable struct |
| tools over the environment | `Toolset<W>` of `Tool<W>` |
| the agent pipeline (tool-calling loop) | `Agent` over an `OpenRouter` model |
| a defense that gates tool calls | `BatonGate` (direct `baton-core`) |
| utility / security checkers | `UtilityCheck` / `SecurityCheck` |
| an attack (indirect prompt injection) | `Attack` + `InjectionVector` |
| benign-utility / ASR / … metrics | `Metrics::aggregate` |

## The baton gate

`Agent::run_defended` interposes a `BatonGate` at the tool-dispatch seam and runs
baton's enforcement protocol per call — **`evaluate → execute → record_result`**:

- reading untrusted data taints the run's context label;
- a call into a sink whose contract the tainted context cannot satisfy is
  **blocked** — not executed — and the reason is handed back to the model;
- a permitted call runs, and its contract-fixed output label is folded in.

Because the engine is linked in-process (not the `baton-check` subprocess), the
gate has full access to baton's audience, effects, and authority machinery that
the stateless JSON wire format cannot express. Contracts are baton's own
`ToolContract`; construct them via the re-exported `baton_dojo::baton_core`.

## Scoring

`run_episode` composes an optional attack, the agent run (defended or not), and a
`UtilityCheck`/`SecurityCheck` into one scored `Episode`; `Metrics::aggregate`
folds a benign and an attacked cohort into benign-utility, utility-under-attack,
and attack-success-rate. `security == true` means the **attacker's** goal was
achieved (AgentDojo's polarity).

## Deferred (not in this slice)

- an authored scenario / task catalog, and unit tests;
- streaming responses, retry/backoff, token-usage/cost accounting;
- surfacing baton's audit trail (e.g. declassification records) on `AgentRun`;
- attention/confirmation gates (available in `baton-core` for a later slice);
- multiple providers or domains.
