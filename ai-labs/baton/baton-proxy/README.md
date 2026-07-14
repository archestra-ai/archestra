# baton-proxy

A prototype that puts baton's audience policy on the **inference layer**: an
OpenAI-compatible HTTP proxy sits between an agent harness and the LLM, and when
a tool call would send data outside its audience, it makes the harness ask a
human first — no changes to the harness beyond two lines of config.

The human's approval travels back as an ordinary tool result, so the evidence
lives *in the trajectory itself*. The proxy keeps no state: it rebuilds the
baton trajectory from the request `messages` on every call and re-derives the
decision — the same full-replay design as `baton-check`.

## The flow

Alice asks the agent to email a finance summary to an external auditor who is
not a reader of the invoices.

1. The model calls `send_email(to = alex@finance-audit.com, …)`.
2. The proxy rebuilds the trajectory, sees the invoices' audience is
   `{alice, bob}`, and that the auditor is outside it — an `AudienceExceeds`
   flow. It **rewrites that tool call** in the response into a call to
   `baton__request_approval`, carrying the tool, recipients, and reason.
3. The harness runs `baton__request_approval` like any other tool. It reaches
   the approver, which asks the person **through the MCP client's own UI** (via
   MCP elicitation) and waits for accept/decline.
4. On accept the approver returns `GRANTED {"tool":"send_email","recipients":["alex@…"]}`.
   The harness appends it as a tool result.
5. On the next request the proxy replays the trajectory, finds the `GRANTED`
   record, and permits the re-issued `send_email` — it passes through untouched
   and the harness sends it. On `DENIED`, the retry is blocked terminally and
   never re-prompts.

```
harness ──chat/completions──▶ baton-proxy ──▶ LLM
   │                              │  rewrites blocked call → baton__request_approval
   ├──tools/call baton__…──▶ baton-approver ──elicitation──▶ human (in the client UI)
   │                              │  returns GRANTED/DENIED
   └──retry send_email──▶ baton-proxy ──▶ (permitted) ──▶ LLM
```

Because the proxy rewrites the blocked call into the approval call (rather than
returning a text instruction), an autonomous tool loop drives the whole flow on
its own — the model never sees a dead end.

## Components

- **`baton-proxy`** — the HTTP proxy. `POST /v1/chat/completions`, forwards
  upstream, rewrites blocked tool calls. Config in `policy.toml`.
- **`baton-approver`** — an MCP server (streamable HTTP) exposing one tool,
  `baton__request_approval`. It runs no policy; it asks the connected client's
  user to accept/decline via MCP **elicitation** (so the prompt shows up in the
  client's own UI, e.g. Claude Code) and returns the ruling as a string the
  proxy parses. Accept → `GRANTED`, decline/cancel/unsupported → `DENIED`.
- **`baton-demo-agent`** — a [rig](https://docs.rig.rs) agent (built with
  `--features demo`) that plays the external harness. Its LLM points at the
  proxy, and its `baton__request_approval` tool is a **real MCP client call** to
  `baton-approver` — so it drives the whole system, elicitation included. It
  answers the approver's elicitation by prompting you y/n (standing in for the
  approval UI a client like Claude Code would render).

## Policy

`policy.toml` declares the requesting user's label, the upstream, and a contract
per tool (audience readers, trust, effects, requirements, and which arguments
carry recipients). See the checked-in `policy.toml` for the auditor scenario.
Tools without a contract are outside the policy and pass through untouched
(gradual adoption — annotate the risky tools, leave the rest).

## Run the demo

Needs an `OPENROUTER_API_KEY` (the proxy forwards your `Authorization` header
upstream, so the key is what the demo agent sends).

One command — `run-demo.sh` builds everything, starts the approver and proxy,
runs the agent, and cleans up on exit. It resolves the key from the environment
or `ai-labs/.env` (including the main checkout's, when run from a worktree):

```sh
ai-labs/baton/baton-proxy/run-demo.sh
# or with a different ask: run-demo.sh --task "email bob@archestra.ai the summary"
```

The agent reads the invoices and tries to email the auditor; the proxy turns
that into a `baton__request_approval` call; the demo runs it against the
approver, which elicits — so the y/n prompt appears in your terminal. Answer `y`
and the send goes through; `n` and the model backs off. This is the whole real
system (proxy + MCP approver + elicitation); a client like Claude Code would
replace the demo agent (see "Wire your own harness").

To run the three processes by hand instead:

```sh
cd ai-labs/baton/baton-proxy
cargo run --bin baton-approver                      # terminal 1
cargo run --bin baton-proxy -- --policy policy.toml # terminal 2
export OPENROUTER_API_KEY=sk-...                    # terminal 3
cargo run --features demo --bin baton-demo-agent
```

## Trajectory log

`baton-proxy --log trajectory.jsonl` appends one JSON line per evaluated
tool-call turn — the folded context audience, the tool, its recipients, the
outcome (`permitted` / `needs_approval` / `terminal`), and the reason:

```json
{"ts_ms":1783978244211,"context_audience":"{alice@archestra.ai, bob@archestra.ai}","tool":"send_email","outcome":"needs_approval","recipients":["alex@finance-audit.com"],"reason":"breach: recipients outside context audience: alex@finance-audit.com"}
```

It records the proxy's *decisions* (the durable trajectory record itself is the
harness's message history). For the engine's step-by-step reasoning instead, run
with `RUST_LOG=baton_core=debug` (to stderr).

`--wire-log-dir <dir>` additionally writes the raw model traffic — one
timestamped `model-wire-*.jsonl` per run, one line per turn (request, raw model
response, returned response). Pretty-print either log with the built-in
renderer, which flags the turns baton rewrote:

```sh
baton-proxy render                        # newest wire-logs/model-wire-*.jsonl
baton-proxy render <file>                 # a specific wire or trajectory log
```

## Wire your own harness

Two changes, both mechanical:

1. Point the harness's OpenAI `base_url` at the proxy (e.g.
   `http://127.0.0.1:8730/v1`).
2. Run `cargo run --bin baton-approver` and register it as an MCP server
   (streamable HTTP at `http://127.0.0.1:8731/mcp`) so `baton__request_approval`
   is an available tool.

The approver asks for approval via MCP **elicitation**, so the client must
support it (e.g. Claude Code); a client that does not will get a `DENIED`
(fail closed). Streaming is not supported (`stream: true` returns 400); set
`stream: false`.

## Trust model (prototype)

The harness is trusted: it alone writes tool-role messages, and only from
results real MCP servers returned — so a `GRANTED` record in the trajectory is
authentic by assumption. The model and other tools' *content* are not trusted:
injected text cannot fabricate a tool-role approval record; the worst it can do
is get the model to *request* approval, and a human sees every request.

Deliberate limitations, documented rather than hidden:

- **No cryptography.** A harness that copies the messages array copies its
  approvals with it, and a compromised harness can forge one. Both are outside
  the threat model — matching `baton-check`'s "permits never cross the process
  boundary" posture.
- **Audience, not content.** An approval admits the ruled-on *recipients* for a
  tool; baton polices who can read, not the message body. Re-sending different
  content to the same approved recipient is allowed; sending to a *different*
  outside recipient re-blocks.
- **Regenerated retries.** Since the blocked call is replaced by the approval
  call, the model reconstructs the original send from context after `GRANTED`
  rather than replaying exact bytes.
- **Needs the full trajectory.** The proxy re-derives everything from the
  request `messages` every call, so **context compaction / windowing breaks it**:
  if a harness trims the tool result that established an audience (or keeps only
  the model's own summary of it — assistant text carries no label), the replayed
  context widens and a later send may be permitted that should not be. Give the
  proxy the untruncated conversation. A poisoned or now-inconsistent history
  fails closed (409) on every request until corrected.
- **Same-turn parallel calls.** Calls emitted together in one response are judged
  against the pre-turn context, so a read and a dependent out-of-audience send in
  the *same* assistant turn are not serialized (the cross-turn form is caught).
  Prefer sequential tool calls.
- **Only audience flows are approvable.** A block that also needs trust, effects,
  or confirmation is terminal, not routed to a human (approval is recorded as
  admitted recipients only). Acknowledge-only taint / unknown-effects escalations
  are auto-acknowledged, matching baton-core's sign-off model.
- **Only annotated tools are gated.** A tool with no contract passes through
  regardless of `unknown_policy` (which governs unknown *dimensions* within
  annotated flows, not unannotated tools).
- No TLS, no persistence, no multi-approver queue, no execute-once across
  conversation forks. Upstream response headers (rate-limit, request-id) are not
  forwarded back.

## Develop

```sh
cargo test
cargo clippy --all-targets --all-features -- -D warnings
cargo fmt --check
```

Standalone crate (its own `[workspace]`), like `baton-core` and `baton-check`.
Concepts of the policy engine live in `baton-core/src/lib.rs`.
