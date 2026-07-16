# baton-demo — the gateway demo

`baton-demo` is the ad-hoc demo harness for the baton prototype: the
**tool-layer gateway** described here. The inference-layer proxy is a separate
crate, `baton-proxy`.

A real agent, a real MCP gateway, and the policy engine between them. An rmcp
server mimics an Archestra-style **tool gateway**: it serves a scenario's
tools, checks every `tools/call` against baton-core, and **soft-blocks** calls
that breach policy — the block comes back as an ordinary tool result telling
the model how to escalate. When the model escalates, a human rules once
(through the MCP client's own UI, via elicitation), and the gateway dispatches
the **exact canonical request the engine checked** — the model never re-issues
the call, so nothing can drift between what was approved and what runs.

Unlike `baton-proxy` (inference layer, full-conversation replay per request),
the gateway sits on the tool layer and owns a live trajectory per MCP session.

## The flow

Alice's agent is asked to email a finance summary to an external auditor who
is not a reader of the invoices.

1. The model calls `invoices_list`; the result enters the trajectory wearing
   its contract label (audience `{alice, bob}`, trusted). Permitted — the
   gateway executes and returns it.
2. The model calls `send_email(to = alex@finance-audit.com, …)`. The gateway
   folds the flow (arguments + control, conservatively all prior tool
   outputs), sees the auditor outside the audience, and returns a **soft
   block**: violations plus "call `baton__escalate` with a reason".
3. The model calls `baton__escalate(reason = …)`. The gateway walks the
   engine's remedy plan; the first grant routes to the external
   `human-in-the-loop` authority, so it **elicits** the connected client's
   user. One accept/decline rules every authorization this remedy needs
   (durably raise the argument values' labels, release the control
   dependencies, acquire the egress growth).
4. On accept, the engine permits; the gateway releases and dispatches the
   canonical request, and the escalation result returns `GRANTED — executed`
   with the tool's real output. On decline: `DENIED`, terminal for that
   action; the model explains to the user instead.

```
baton-agent (rig, LLM via OpenRouter — no proxy)
   │  MCP (streamable HTTP; client supports elicitation)
   ▼
baton-gateway ── tools/call ──▶ baton-core evaluate
   │   permitted → execute simulated tool ← canonical request only
   │   remediable → soft-block tool result
   │   baton__escalate → remedy walk → elicit human ──▶ y/N in the client
   └── every decision narrated + optional JSONL log
```

## Scenario config (`gateway.toml` + `gateway-policy.toml`)

Two TOML files declare the scenario, joined by tool name. `gateway.toml` is
the demo-owned tool catalog: the tools the gateway serves (description, string
arguments, a `result` template filled from the canonical request).
`gateway-policy.toml` is the policy — tool contracts and authorities — in the
canonical `baton-contracts` dialect, the same one `baton-proxy` reads: per
tool a `requires` section (trust, an audience as `"public"`, a reader list, or
`"$.args.<argument>"` naming the wire argument that carries recipients) and an
`output` section (trust, audience, effects); per authority a `rule` —
`"allow"` for the narrow inline acknowledge-only competence, `"escalate"` for
the full-mandate human-in-the-loop authority the gateway elicits.

A catalog tool without a contract is served but unregistered — calling it is
unprovable and routes through the same authority chain, baton's fail-closed
default. A contract naming no catalog tool is a load error. Within a present
contract, omissions fail **closed**: an absent `requires` table means unknown
requirements (write `requires = {}` to declare "considered, nothing
required"), and an omitted output trust/audience is unknown — spell out what
you mean. Only `effects` defaults to none.

One gateway policy decision worth knowing: an escalation elicits the human
**once per authority** the remedy routes to, and that ruling is applied to
every grant the same authority must rule on — never to another authority's.
The conservative provenance fold (every argument reads all prior tool outputs)
means an out-of-audience send needs several grants — per-grant prompts would
ask the same human the same question four times. The checked-in scenario has
one authority, so one prompt. No ruling at all (elicitation failure, timeout,
dismissal) fails closed without recording a human decision: the action stays
pending and can be escalated again.

## Run the demo

Needs an `OPENROUTER_API_KEY` (environment or `ai-labs/.env`).

```sh
ai-labs/baton/baton-demo/run-gateway-demo.sh
# gateway engine internals too:
ai-labs/baton/baton-demo/run-gateway-demo.sh -v      # decision path
ai-labs/baton/baton-demo/run-gateway-demo.sh -vv     # + label algebra
# different ask:
ai-labs/baton/baton-demo/run-gateway-demo.sh --task "email the summary to bob@archestra.ai"
```

The gateway's narration (`✓ permitted`, `⚠ soft block`, `✋ approved →
dispatched`) interleaves with the agent in one terminal; answer `y` and the
send goes through, `n` and the model backs off.

By hand instead:

```sh
cd ai-labs/baton/baton-demo
cargo run --bin baton-gateway -- -v                  # terminal 1
export OPENROUTER_API_KEY=sk-...                     # terminal 2
cargo run --bin baton-gateway-agent
```

`--log <file>` appends one JSON line per decision:
`{"ts_ms":…,"tool":"send_email","recipients":["alex@…"],"outcome":"soft_blocked","reason":"…"}`.

## Wire your own harness

Register the gateway as an MCP server (streamable HTTP at
`http://127.0.0.1:8732/mcp`) in any client that supports **elicitation**
(e.g. Claude Code) — the approval prompt then renders in that client's own UI,
and `baton-gateway-agent` is unnecessary. A client without elicitation gets a
denial (fail closed).

## Trust model (prototype)

The gateway executes the tools itself, so — unlike the proxy — there is no
trusted-harness assumption for results: a value's label comes from the
contract of the dispatch that produced it, and approvals are engine state,
not conversation text. What remains deliberately out of scope:

- **Simulated tools.** Executors render a canned template from the canonical
  request; wiring real tools means replacing one function, not the mediation.
- **Conservative provenance — over tool outputs only.** The gateway never sees
  the LLM's context, so every argument is assumed derived from every prior
  tool output (the conservative upper bound at this layer). The flip side:
  anything that never entered through a mediated tool call — the user and
  system prompts — is invisible and implicitly treated as public and trusted.
  A secret pasted into the prompt is outside the policy. Value-granular (and
  prompt-aware) reads need the inference layer (see `README.md`).
- **One pending action per session.** A different call while one is
  soft-blocked abandons the blocked one; a re-issued identical call re-enters
  it. Once an action *completes*, an identical retry is a **new** action that
  re-enters policy — the gateway keeps no completed-call cache, so a
  transport-level retry of a lost response must be replayed by the transport
  (streamable HTTP resumability), not re-issued as a fresh `tools/call`.
- No TLS, no persistence, no multi-approver queue; approvals do not survive a
  gateway restart (linear capabilities cannot be serialized back — by design).

## Develop

```sh
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --check
```

This is the `baton-demo` crate (bins `baton-gateway` and `baton-gateway-agent`;
library module `gateway`). Standalone on purpose — deliberately outside the
shared `ai-labs` workspace, to keep the heavy demo deps (a full agent framework
and LLM client) out of the workspace build. Concepts of the policy engine live
in `baton-core/src/lib.rs`.
