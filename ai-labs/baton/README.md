# baton

Prototype of an ADT-based information-flow policy engine for LLM agents.
Instead of filtering prompts and outputs, it asks: *can this value, derived
from these sources, legally flow into this sink?*

The engine is value-granular. A trajectory owns an immutable store of labeled
values with full provenance; a tool request carries the executable argument
tree (recipients, paths, payloads are values in it) plus the control
dependencies of whatever selected the invocation, and is checked against
`L_flow = combine(L_args, L_control)` — never against the whole conversation.
A raw value elsewhere in the trajectory does not taint an unrelated sink,
but it still taints anything derived from it, including the *choice* to act
(implicit flows). Effects are monotone trajectory state committed when
dispatch begins; audit is control-plane history.

A blocked flow is either terminal or comes with typed remedy plans, one of
five kinds:

- **Sanitize** — a registered transformer derives a new value under its
  declared label (content-justified); the raw source keeps its own.
- **Constrain** — a registered tool-identity mapping narrows the pending
  action (network fetch → cache-only fetch), verified never wider.
- **Endorse** — an authority durably relabels a value by fiat, minting a new
  value under endorsed provenance; raising trust or audience is always a
  relabel, never a waiver.
- **Accept** — an authority acquires a surface growth on the effect axis; the
  effect still commits to the monotone past at release, never early.
- **Waive / Acknowledge** — a check-transient lift (a prior effect, a
  confirmation stand-in, releasing named control deps — nothing else) or an
  on-the-record acknowledgment of an unprovable fact; changes no stored state.

Authorities live in one registry — inline functions or external approval
round-trips — routed by mandate competence, inline-first in registration
order, with a fail-closed recheck after every grant. `Unknown` is a
first-class label and fail-closed: an unprovable flow routes through the same
authority chain as a breach, no policy knob — annotate five high-risk tools,
leave the rest unknown, still catch the obvious flows.

Every applied step is a linear, revision-bound capability: one-shot,
rechecked, audited; any state change invalidates everything minted before it.
Dispatch is two-phase — release commits may-effects and renders the one
canonical request from the exact checked tree, a receipt must close the
action — and the final assistant response is a mediated sink like any tool.

`baton-authority-model-design.md` is the plan-of-record;
`baton-declassifier-design.md` is the foundation rationale it builds on;
concepts and semantics are documented in `baton-core/src/lib.rs`.

```sh
cd baton-core
cargo run --example demo
cargo run --example scenarios   # declarative pipelines from scenarios.toml
cargo test
```

`agentdojo-harness/` evaluates the engine against the AgentDojo
prompt-injection benchmark (with `baton-check`, a stateless JSON oracle over
baton-core); see its README.

`baton-proxy/` is a prototype that puts the engine on the inference layer: an
OpenAI-compatible HTTP proxy that, when a tool call would send data outside its
audience, rewrites it into a call to a human-approval MCP server and lets the
retry through once approved. See its README.
