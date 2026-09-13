# Native APPA Proxy Qualification

This integration is experimental. Qualification requires correlated runtime receipts, proxy ledger state, and fixture effects. A client's exit status alone is not evidence that a policy boundary was exercised.

Integration PR: [archestra-ai/archestra#7833](https://github.com/archestra-ai/archestra/pull/7833).
Runtime PR: [archestra-ai/OpenAPPA#297](https://github.com/archestra-ai/OpenAPPA/pull/297).

## Verified Flows

Stock OpenCode 1.18.29 passed both child scenarios on the retained GCP development stack with the same configured return floor:

| Scenario | Run | Strict Result | Observed Behavior |
| --- | --- | --- | --- |
| `child-private-return-denied` | `run-20260913t182714z-56b0edc220cecac1` | 50/50 | No parent source read. The exact marked-spawn offer declared the `ops` floor. The child admitted its private read and returned a non-void value. The exact parent publication was denied after that return. No publication occurred. |
| `child-public` | `run-20260913t182833z-dba3e23b5f140afb` | 44/44 | The child admitted its public read and completed under the exact consumed parent spawn binding and shared root. The parent published once. |

Both runs checked request-body/receipt integrity, child-source admission state and order, fixture/gateway argument hashes, and per-call phase evidence. Both source archives verified against the repository and the launcher copies. The earlier `child-private-denied` scenario remains separate: it pre-taints the parent and tests preservation of inherited restrictions, not child-only acquisition.

The deployed operator floor comes from `ARCHESTRA_LLM_PROXY_APPA_NATIVE_SPAWN_RETURN_FLOOR_MAP`. It is not a model-selected label. Runtime tests establish that declaring the floor does not pre-taint the parent; the restriction reaches the parent on the child's return.

The matching harness source fingerprints are:

| Source | SHA-256 |
| --- | --- |
| `native-live-runner.py` | `622fcd7b6168339c42fa314d7b637149f028af79948e7a2fab05b8b1e185d4fb` |
| `native-live-collector.py` | `70ce54827d2bedc3afcb68386d61a260c4a6ed8eda5b902e3d2cd25f7fac8155` |
| `native-live-assert.py` | `18ca14bf48637435fab324e4df2fafcb3187c3a5090bd545afe76a0a01aa8174` |
| `native-live-scenarios.json` | `ecc3517c2099ae479f6176f8ca01dd3fa2d50b722a776a81b1d366d5bca2f88a` |

These results apply to the archived deployments and source hashes. They do not establish qualification of every later commit or another scenario.

## Remaining Qualification

| Area | Evidence And Limit |
| --- | --- |
| Codex 0.153.0 native children | Run `run-20260913t181900z-2cf5e3f99e239d80` created a distinct child session, bound the exact spawn result, and consumed its capability once. The child was then quarantined before its first runtime event; no child source or lifecycle receipts exist. Parent publication alone does not qualify this run. The earlier active-parent-session symptom did not recur. |
| Other client/private combinations | OpenCode child-only private return is verified above. The equivalent Codex flow and a current-head Claude child/private matrix are not established by that evidence. |
| Sanitizer and held controls | Historical `source-result-sanitized` runs used an already-public summary. They do not prove transformer execution, a completed held-control remedy, or model regeneration. Codex and OpenCode archived results also lacked required fixture/publication linkage. |
| Approval, denial, expiry, replay | Backend/runtime tests cover several boundaries. No complete archived stock-client and authenticated browser qualification establishes this matrix. |
| Fork and compaction | Earlier experiments are not current-head qualification. Require exact checkpoint or same-root continuity, retained restrictions, and denied private publication. |

## Enforcement Scope

The proxy controls provider requests, released tool calls, client-visible call identities, and durable session history. Gateway changes execute server-issued held controls and validate their receipts. The runtime owns policy decisions and child return constraints. This is not an unchanged-gateway or proxy-only implementation.

Held-response continuation rebuilds a server-held response. It is not a new model completion and must not be described as model argument regeneration.

The phase trace records completion of the local response write, not acknowledgement by the client. The live fixture is synthetic; providers and stock clients are real. Private credentials and raw runtime data are excluded from this report.

## Local Validation

The final APPA regression group passed 300 tests; nine environment-gated integration tests remained skipped. The evidence harness passed 46 tests, including mutations of parent identity, child identity, return floor, source state, event integrity, and lifecycle order. Its complete SQL runs against the migrated test database and checks explicit timestamp offsets and parent source counts. Platform type-check, lint, code generation, backend export checks, and migration consistency checks passed; lint retains unrelated existing warnings.
