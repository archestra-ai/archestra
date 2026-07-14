# baton-check

Stateless JSON policy check over [baton-core](../baton-core): reads one
request from stdin, prints one decision to stdout, exits. The request carries
everything — the policy (`unknown_policy`, `taint_policy`, tool `contracts`),
the user prompt, the `executed` calls so far, and one `proposed` call.
baton-check replays the episode from scratch, evaluates the proposed call
against its contract, and reports allow/block. Because each invocation
rebuilds the trajectory, no state (and no permit linearity) ever crosses the
process boundary.

Exit 0 with a decision on stdout; exit 2 with `{"error": …}` on malformed
input or a protocol violation. Wire types live in `src/protocol.rs`.

This crate exists only as a sidecar for [agentdojo-harness](../agentdojo-harness),
which shells out to it before executing each tool call the LLM emits (see the
harness's `bridge.py`; it builds the binary on first use, or set
`BATON_CHECK_BIN`). It is a standalone workspace on purpose and is not part of
anything else — if you are not running the AgentDojo benchmark, you don't need
it; use baton-core directly.

```sh
cargo build --release
cargo test
```
