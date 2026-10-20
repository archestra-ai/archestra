---
title: Roll Out Usage Accounting
description: Activate component billing without resetting existing budgets.
order: 8
lastUpdated: 2026-10-20
---

Usage accounting includes separately billed inference, such as an Anthropic advisor or compaction pass, in the request's cost and matching budgets.

## Activate Settlement

Deploy the compatible backend to every web and worker pod before enforcing component charges.

1. Deploy with [`ARCHESTRA_LLM_PROXY_USAGE_ACCOUNTING_MODE=off`](/docs/reference/configuration#ARCHESTRA_LLM_PROXY_USAGE_ACCOUNTING_MODE). The additive migration creates accounting storage without rewriting interaction logs or resetting budgets.
2. Set the mode to `shadow` on web and worker pods. Compare candidate quotes with provider usage, including cache reads, cache write TTLs, advisors, and compaction. Confirm that every billed model has trusted pricing and that candidate records are complete.
3. Wait for older pods and their in-flight requests to finish. Set the mode to `enforce` across the deployment, then check a test credential with a small budget: a completed charge over its limit must block the next request with HTTP `402`.

Activation applies to requests that start in enforce mode. Existing consumption remains in the current budget window. Activation does not backfill missing historical components; settled charges retain their quoted prices, while legacy counters retain legacy pricing behavior.

## Understand User Impact

Clients keep their credentials and endpoint URLs. An enforced request records its charge before returning its final success; content can stream while the provider works.

- Advisor and compaction charges can exhaust a budget sooner than executor-only charges.
- Subscription traffic continues to have $0 billed spend. A credential's billing team pays instead of the caller.
- Unknown prices, unsupported billing components, or partial usage block further requests against affected budgets until the accounting issue or budget window is resolved. A database settlement failure returns an error instead of successful accounting.
- Budgets check consumption before a request. Concurrent requests already in flight can exceed a limit; settlement does not reserve funds.

A rolling restart can interrupt active streams and Chat or A2A runs. Streams cannot move between pods; schedule the rollout for a quiet period and use the deployment's drain policy.

## Roll Back Safely

Keep the additive accounting storage when reverting the application.

An accounting-aware backend continues to include previously settled charges even after switching the mode to `off` or `shadow`. An older backend can serve against the compatible schema, but cannot read fixed component charges correctly; treat that as a temporary loss of accounting guarantees and restore the compatible backend before relying on budget accuracy.

Accounting receipts survive log-content redaction and log retention so that an internal retry of the same settlement cannot charge a new budget window. A new client request still incurs its own provider charges. Do not delete receipts as part of log cleanup.
