# baton

Prototype of an ADT-based information-flow policy engine for LLM agents.
Instead of filtering prompts and outputs, it asks: *can this value, derived
from these sources, legally flow into this sink?*

The engine is value-granular. A trajectory owns an immutable store of labeled
values with full provenance; a tool request carries the executable argument
tree (recipients, paths, payloads are values in it) plus the control
dependencies of whatever selected the invocation, and is checked against
`L_flow = combine(L_args, L_control)` — never against the whole conversation.
A raw value elsewhere in the trajectory no longer taints an unrelated sink,
but it still taints anything derived from it, including the *choice* to act
(implicit flows). Effects are monotone trajectory state committed when
dispatch begins; audit is control-plane history.

A blocked flow is either terminal or comes with typed remedy plans:

- **TransformValue** — a registered transformer (e.g. PII redaction) derives
  a new value under its declared label; the raw source keeps its own.
- **ConstrainAction** — a registered tool-identity mapping narrows the
  pending action (network fetch → cache-only fetch), verified never wider.
- **ApplyWaiver** — an inline policy rule or an external adjudicator grants a
  typed, check-transient loosening (trust attestation, audience vouch, effect
  waiver, confirmation stand-in, control release), audited per dimension.

Every applied step is a linear, revision-bound capability: one-shot,
fail-closed rechecked, audited, and any state change invalidates everything
minted before it. Tool execution is bound to the exact checked tree (the
adapter gets one canonical rendering and a receipt that must close the
action), and the final assistant response is a mediated sink like any tool.
`Unknown` is a first-class value with policy-chosen meaning (annotate five
high-risk tools, leave the rest unknown, still catch the obvious flows).

Design rationale for this revision lives in `baton-declassifier-design.md`;
concepts and semantics are documented in `baton-core/src/lib.rs`.

```sh
cd baton-core
cargo run --example demo
cargo test
```
