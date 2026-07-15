# baton-proxy

Puts baton on the **inference layer**: an OpenAI-compatible HTTP proxy that
sits between an agent harness and the LLM and blocks tool calls that fail their
baton contract, before the harness ever sees them — no changes to the harness
beyond pointing its `base_url` at the proxy.

The proxy keeps no state. On every `/v1/chat/completions` response it rebuilds
the baton [`Trajectory`](../baton-core) from the request `messages`, evaluates
each proposed tool call against a `PolicyEngine`, and rewrites the response: a
call that fails its contract is replaced with a short stop explanation on the
normal text channel, so the model sees why and takes a different approach. A
blocked call is never returned to the harness and never executed.

Unprovable flows fail closed unless the policy declares an authority competent
to acknowledge them (see the Policy section) — anything an authority cannot
clear stays blocked. (The earlier human-approval variant — where a blocked
call became a request to a human over MCP — is in PR #6551 on `main`; it
predates the current value-granular baton-core and will return as a port to
External authorities.)

## Policy

The proxy loads one TOML document: the upstream URL plus a `[contracts]` block
parsed by [`baton-contracts`](../baton-contracts) into `ToolContract`s.

```toml
upstream_base_url = "https://openrouter.ai/api/v1"

[contracts.user]
id = "operator"

[[contracts.tool]]
name = "read_notes"
output = { trust = "suspicious", audience = "public" }   # third-party text taints the flow

[[contracts.tool]]
name = "delete_file"
output   = { trust = "trusted", audience = "public" }
requires = { trust = "trusted" }    # a mutation may not run from a tainted flow

[[contracts.tool]]
name = "create_issue"
requires = { audience = "public" }  # sink exposes to everyone: only a public flow passes

[[contracts.tool]]
name = "send_report"
requires = { audience = ["ops-hook"] }  # sink exposes to fixed readers the flow must cover

[[contracts.tool]]
name = "notify"
requires = { audience = "$.args.url" }  # sink audience read from the call's `url` argument

[[contracts.tool]]
name = "search_notes"   # no `requires` at all — an unprovable fact, not "nothing required"

[[contracts.authority]]
name = "default-allow"
rule = "allow"
acknowledge_unknown = true
```

Every tool contract has two sections. `output` is how the returned
information is labeled and how the call modifies the trajectory — omitted
fields default to **unknown** (fail closed at any guarded sink downstream),
except `effects`, which defaults to none. `requires` is what the current
trajectory must satisfy: a trust bar, an attention rule, forbidden prior
effects, and `requires.audience` — the sink's audience, who a call exposes
the flow to. That check is always the same comparison: the flow's audience
(folded by intersection from everything read) must cover the sink's. It comes
in three forms — `"public"`, a fixed reader list, or `"$.args.<argument>"` to
read the recipients from one top-level call argument. Absent means the tool
exposes no one and gets no audience check.

An absent `requires` means the requirements are **unknown** — every call
escalates as an unprovable fact and fails closed unless an authority clears
it. Write `requires = {}` to say "considered, nothing required". A policy may
declare that authority itself: `[[contracts.authority]]` with `rule = "allow"`
and `acknowledge_unknown = true` approves exactly the unprovable facts routed
to it (unknown requirements, unknown effects) and records each grant in the
decision log — proven breaches are outside its competence and stay blocked.
Tools with no contract at all never reach it — they pass through unevaluated,
per the line below.

Tools without a contract pass through untouched — annotate the risky few, leave
the rest.

## Run

```sh
cargo run --bin baton-proxy -- --policy policy.toml --addr 127.0.0.1:8730
# point the harness at http://127.0.0.1:8730/v1; its Authorization header is
# forwarded upstream. --log <file> records one JSON line per gated tool call;
# `render` pretty-prints a wire or decision log.
```

For a full end-to-end example — the proxy as a sidecar gating a real agent's
Kubernetes tools — see [`../demo/kagent`](../demo/kagent).
