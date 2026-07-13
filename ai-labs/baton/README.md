# baton

Prototype of an ADT-based information-flow policy engine for LLM agents.
Instead of filtering prompts and outputs, it asks: *can this value, derived
from these sources, legally flow into this sink?* Labels travel with every
trajectory turn, a per-dimension algebra folds them into a context label, and
a tool contract is checked by a per-dimension adequacy relation
(holds / fails / unprovable). A failing flow derives the grant that would
cover it and routes it to an authority whose mandate covers that grant; on
approval the grant is applied, rechecked fail-closed, and recorded as an
audited declassification. `Unknown` is a first-class value with policy-chosen
meaning (annotate five high-risk tools, leave the rest unknown, still catch
the obvious flows).

Concepts and semantics are documented in `baton-core/src/lib.rs`.

```sh
cd baton-core
cargo run --example demo
cargo test
```

`agentdojo-harness/` evaluates the engine against the AgentDojo
prompt-injection benchmark (with `baton-check`, a stateless JSON oracle over
baton-core); see its README.
