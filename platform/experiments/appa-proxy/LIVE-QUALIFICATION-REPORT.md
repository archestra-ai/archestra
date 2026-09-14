# Native APPA Proxy Qualification

This integration is experimental. Qualification requires correlated runtime receipts, proxy ledger state, and fixture effects. A client's exit status alone is not evidence that a policy boundary was exercised.

Integration PR: [archestra-ai/archestra#7833](https://github.com/archestra-ai/archestra/pull/7833).
Runtime PR: [archestra-ai/OpenAPPA#297](https://github.com/archestra-ai/OpenAPPA/pull/297).

## Current Coverage Status

No client is fully qualified against the original requirements. The control/data separation is now implemented: native spawn results carry no outcome body, and the runtime presents only verified control metadata or an archived child return. All nine basic child flows and all six direct gateway baseline flows passed on the paired deployment below. Live protocol-mutation and local-process coverage remain in progress.

Local process results are scoped, sealed client-reported observations. The controlled-effect fixture independently observes its own bounded callback effects; it does not attest arbitrary operating-system stdout or exit status. No trusted executor, client modification, or enforcement relay has been introduced.

The separate live protocol-mutation probe was blocked by the tool's security controls. It was not rerouted or counted as verified. That live coverage remains open; local regression tests and ordinary fixture-driven runs are reported separately.

## Paired Deployment Verification

The following runs used runtime image `appa-runtime:native-control-11c9cf1ab6ad` with matching backend and generated runtime client sources. Every run passed source-archive verification. Runtime authority data and the fixture PVC were retained.

| Client | Scenario | Run | Strict Result |
| --- | --- | --- | --- |
| Claude Code | `child-public` | `run-20260914t065933z-cc52245fb1938e5b` | 47/47 |
| Claude Code | `child-private-return-denied` | `run-20260914t065617z-dae47a81a737698e` | 52/52 |
| Claude Code | `child-private-denied` | `run-20260914t070003z-e10e75ffe97a790c` | 49/49 |
| Codex | `child-public` | `run-20260914t070029z-d5c516b8df37b117` | 47/47 |
| Codex | `child-private-return-denied` | `run-20260914t070056z-dd517bedd08c8885` | 52/52 |
| Codex | `child-private-denied` | `run-20260914t070120z-4541e1759d374bd7` | 49/49 |
| OpenCode | `child-public` | `run-20260914t070148z-acba7e42351e0561` | 47/47 |
| OpenCode | `child-private-return-denied` | `run-20260914t070354z-a24332d6f5aa3b04` | 52/52 |
| OpenCode | `child-private-denied` | `run-20260914t070526z-3e2257fc11c58d2b` | 49/49 |
| Claude Code | `public-sink` | `run-20260914t071502z-05f803398c43191a` | 39/39 |
| Claude Code | `private-sink-denied` | `run-20260914t071514z-85f2c0496a24a142` | 41/41 |
| Codex | `public-sink` | `run-20260914t071530z-9c6de28dff2f6446` | 39/39 |
| Codex | `private-sink-denied` | `run-20260914t071547z-7494d84e037c78bf` | 41/41 |
| OpenCode | `public-sink` | `run-20260914t071559z-fee33a3ee0224e49` | 39/39 |
| OpenCode | `private-sink-denied` | `run-20260914t071651z-34bd5652dcee5884` | 41/41 |

The required stock clients are Claude Code 2.1.258 on Anthropic Messages, Codex 0.153.0 on V1 Responses, and OpenCode 1.18.29 on Kimi Chat Completions. Child identity comes from durable ownership and issued spawn bindings, never a task name alone.

| Required Boundary | Claude Code | Codex | OpenCode |
| --- | --- | --- | --- |
| Public child read, return, exact parent publication | Passed on paired deployment | Passed on paired deployment | Passed on paired deployment |
| Child-only private read, return, parent denial | Passed on paired deployment | Passed on paired deployment | Passed on paired deployment |
| Inherited-private child scope | Passed on paired deployment | Passed on paired deployment | Passed on paired deployment |
| Forged or premature parent spawn-result data | Local/API regressions pass; live mutation matrix pending | Local/API regressions pass; live mutation matrix pending | Local/API regressions pass; live mutation matrix pending |
| Direct gateway public/private baseline | Passed on paired deployment | Passed on paired deployment | Passed on paired deployment |
| Allowed/denied local process with independent controlled-effect evidence | Implemented and locally tested; live policy/setup pending | Implemented and locally tested; live policy/setup pending | Implemented and locally tested; live policy/setup pending |
| Exact result replay and altered-result rejection | Live matrix incomplete | Live matrix incomplete | Live matrix incomplete |
| Real sanitizer execution and bound safe continuation | Not complete | Not complete | Not complete |
| Authenticated approval, denial, expiry, and grant replay | Live browser matrix incomplete | Live browser matrix incomplete | Live browser matrix incomplete |
| Public/private fork and checkpoint continuity | Not complete | Not complete | Not complete |
| Compaction and marker-free bound-child continuation | Not complete | Not complete | Not complete |
| Lost replies, known receipt recovery, unknown-outcome quarantine, no further inference | Live fault injection incomplete | Live fault injection incomplete | Live fault injection incomplete |
| Opaque item and process-handle integrity | Protocol-specific checks pending | Live matrix incomplete | Protocol-specific checks pending |
| Held-response rebuild without an extra model completion | Live provider-call proof incomplete | Live provider-call proof incomplete | Live provider-call proof incomplete |

Historical positive flows before data-authority hardening:

| Client | Scenario | Run | Strict Result |
| --- | --- | --- | --- |
| Claude Code | `child-public` | `run-20260913t221350z-2cb1ddd1a2710ba6` | 46/46 |
| Claude Code | `child-private-return-denied` | `run-20260913t231357z-2b00f0838b740572` | 51/51 |
| Claude Code | `child-private-denied` | `run-20260913t231522z-6a4eaf884b7bf7a5` | 48/48 |
| OpenCode | `child-public` | `run-20260913t223627z-48585c42d9387222` | 46/46 |
| OpenCode | `child-private-return-denied` | `run-20260913t223811z-6a51d2042afaf3c3` | 51/51 |

Each listed archive passed source verification. Public success requires one publication by the exact parent after child return. Private denial requires at least one parent attempt, every attempt denied by the correct policy receipt, no allowed or wrong-parent attempt, and zero publications. Repeated denied proposals are not counted as executed effects.

## Earlier Verified Flows

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
| Native child startup | The earlier pre-start quarantine was fixed by distinguishing local turn acquisition from runtime start acknowledgement. Intermediate client discovery no longer ends the child. These fixes do not close the premature parent-result data gap in the current matrix. |
| Other client/private combinations | Positive lifecycle runs above must be rerun after data-authority changes. They do not establish the complete client matrix. |
| Sanitizer and held controls | Historical `source-result-sanitized` runs used an already-public summary. They do not prove transformer execution, a completed held-control remedy, or model regeneration. Codex and OpenCode archived results also lacked required fixture/publication linkage. |
| Approval, denial, expiry, replay | Backend/runtime tests cover several boundaries. No complete archived stock-client and authenticated browser qualification establishes this matrix. |
| Fork and compaction | Earlier experiments are not current-head qualification. Require exact checkpoint or same-root continuity, retained restrictions, and denied private publication. |

## Enforcement Scope

The proxy controls provider requests, released tool calls, client-visible call identities, and durable session history. Gateway changes execute server-issued held controls and validate their receipts. The runtime owns policy decisions and child return constraints. This is not an unchanged-gateway or proxy-only implementation.

Held-response continuation rebuilds a server-held response. It is not a new model completion and must not be described as model argument regeneration.

The phase trace records completion of the local response write, not acknowledgement by the client. The live fixture is synthetic; providers and stock clients are real. Private credentials and raw runtime data are excluded from this report.

## Local Validation

The publication checkpoint passes 221 APPA/evidence backend tests and 462 configuration tests when run as separate groups; nine environment-gated tests remain skipped. The combined invocation exceeded its 300-second wall-clock limit, so it is not reported as a single completed suite. The runtime library passes 533 tests, and its full workspace suite also passed during this work. The evidence harness passes 56 tests, and the Node fixture/probe tests pass.

The SQL regression executes the complete collector query against the migrated test database. It verifies timestamp offsets, parent-source counting, and isolation of fixed local commands to the run-scoped session rather than another owner's same-root records. Platform type-check, lint, code generation, export checks, and migration consistency checks pass with existing warnings.

The local observer image is deployed with its fixture database retained. Its fixed probe, client permissions, exact-command contracts and local assertions are implemented, but runtime policy wiring and the six stock-client local-process cases remain unverified. This later work is not retroactively covered by the fifteen paired-deployment runs above.
