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

No authorities are registered, so a flow the contracts cannot prove is blocked,
fail closed. (The earlier human-approval variant — where a blocked call became
a request to a human over MCP — is in PR #6551 on `main`; it predates the
current value-granular baton-core and will return as a port to External
authorities.)

## Policy

The proxy loads one TOML document: the upstream URL plus a `[contracts]` block
parsed by [`baton-contracts`](../baton-contracts) into `ToolContract`s.

```toml
upstream_base_url = "https://openrouter.ai/api/v1"

[contracts.user]
id = "operator"

[[contracts.tool]]
name = "read_notes"
output = { trust = "suspicious" }   # third-party text taints the flow

[[contracts.tool]]
name = "delete_file"
requires = { trust = "trusted" }    # a mutation may not run from a tainted flow
```

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
