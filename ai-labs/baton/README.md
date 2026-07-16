# baton

Prototype of an ADT-based information-flow policy engine for LLM agents.
Instead of filtering prompts and outputs, it asks: *can this value, derived
from these sources, legally flow into this sink?*

The engine is value-granular. A trajectory is an append-only log of scoped
facts; values, effects, lifecycle, grants, and audit are projections over it.
A tool request carries the executable argument tree (recipients, paths,
payloads are values in it) plus the control dependencies of whatever selected
the invocation, and is checked against
`L_flow = combine(L_args, L_control)` — never against the whole conversation.
A raw value elsewhere in the trajectory does not taint an unrelated sink,
but it still taints anything derived from it, including the *choice* to act
(implicit flows). Release appends the may-effect commitment before dispatch;
a failure appends and removes nothing.

Every proposed flow — a tool call or an assistant emission, same pipeline —
settles in one of three outcomes: **allowed now** (a linear permit),
**remediable** (a soft block with predicted plans), or **terminal** (a proven
claim: the uncapped search established that no remedy exists under the
registered capabilities). Stale, foreign, or conflicting proposals are
refusals outside that tri-state and touch nothing. Remedies come in exactly
two kinds:

- **Reduce** — change the flow so it fits: derive a value through a
  registered transformer (the raw source keeps its own label), or narrow the
  pending action through a registered tool-identity mapping (network fetch →
  cache-only fetch), verified never wider.
- **Authorize** — grant the irreducible residual: an exact typed delta at an
  exact scope — durable (minting a derived value under the raised label, the
  source untouched), one pending action (an acquired effect growth, still
  committed only at release), or one policy check (a transient lift or an
  on-the-record acknowledgment of an unprovable fact; grants are issued and
  consumed as facts, so a one-off can never be spent twice).

A soft block returns the irreducible nondominated frontier of plans — no
removable steps, no plan dominated by a smaller ask, incomparable
alternatives retained (control-release rescue is size-first: all
incomparable releases of the smallest cardinality that works; only a
fruitless search sweeps the whole lattice, which is what proves a
terminal block) — so the actor picks its remedy as early as possible. Authorities live in one registry — inline functions or external
approval round-trips — routed by mandate competence over typed deltas and
scopes, inline-first in registration order, with a fail-closed recheck after
every grant. `Unknown` is a first-class label and fail-closed: an unprovable
flow routes through the same authority chain as a breach, no policy knob —
annotate five high-risk tools, leave the rest unknown, still catch the
obvious flows.

Every applied step is a linear capability bound to the event-frontier basis:
one-shot, rechecked, audited; any appended fact invalidates everything minted
before it. Dispatch is two-phase — release commits may-effects and renders
the one canonical request from the exact checked tree, a receipt must close
the action — and the assistant response is a mediated emission sink like any
tool: caller-labeled assistant ingress does not typecheck.

`docs/spec.md` is the normative spec; `baton-authority-model-design.md` is
the plan-of-record; `baton-declassifier-design.md` is the foundation
rationale it builds on; concepts and semantics are documented in
`baton-core/src/lib.rs`.

```sh
cargo test -p baton-core

baton-demo/run-gateway-demo.sh   # the end-to-end demo (needs OPENROUTER_API_KEY)
```

`agentdojo-harness/` evaluates the engine against the AgentDojo
prompt-injection benchmark (with `baton-check`, a stateless JSON oracle over
baton-core); see its README.

`baton-proxy/` puts the engine on the **inference layer**: an OpenAI-compatible
HTTP proxy that replays the conversation into a trajectory and blocks tool
calls that fail their contract before the agent sees them, loading contracts
via `baton-contracts/`, a small crate that translates the declarative policy
into baton-core `ToolContract`s. See its README.

`baton-demo/` is the ad-hoc demo harness: the **tool-layer gateway**
(`README.md`, the demo above), a real rig agent talking to an MCP server that
mimics an Archestra-style tool gateway — it serves a scenario's tools from
TOML, checks every call against baton-core, **soft-blocks** breaches as
ordinary tool results the model can act on, escalates to a human through MCP
elicitation, on approval dispatches the exact canonical request the engine
checked, and routes the agent's final answer through the reserved
`baton__respond` tool so only the emission-checked rendering reaches the user.

`demo/kagent/` wires baton-proxy into a stock [kagent](https://kagent.dev)
agent as a pod sidecar: the agent is prompt-injected by a crashlooping pod's
logs and baton blocks the injected `kubectl delete`, with no changes to the
agent. `./demo/kagent/run-demo.sh` runs it end-to-end on kind.
