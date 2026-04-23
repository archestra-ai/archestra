---
title: Costs & Limits
category: LLM Proxy
order: 2
---

Archestra tracks LLM usage costs, enforces usage limits, and records savings from model optimization and tool-result compression. These controls work together: pricing defines cost, logs and statistics show what happened, limits stop or shape usage, and optimization reduces spend before a request reaches a model.

## Statistics

The statistics view is the rollup layer for LLM traffic. It aggregates usage by time range, team, profile, and model so you can answer questions like:

- which teams are driving spend
- which models are responsible for the largest share of cost
- whether optimization rules or TOON compression are reducing spend over time

For a fuller cost view outside the Archestra UI, use Archestra's exported [metrics](platform-observability#metrics) and the prebuilt [Grafana dashboards](platform-observability#grafana-dashboards). Those surfaces are better suited for long-term monitoring, alerting, and cross-system cost analysis.

This page depends on model pricing being configured correctly. If a model has no pricing, usage can still be logged, but cost calculations will be incomplete.

Archestra stores both raw spend and savings. Savings can come from:

- optimization rules that reroute requests to lower-cost models
- TOON compression that reduces tool-result tokens before the result is sent to the model

## Usage Limits

Usage limits are guardrails for LLM spend. Archestra supports token-cost limits scoped to the organization, a team, an agent, a specific user, or a specific virtual API key. Each limit targets one or more specific models — or every model, via the **Apply to all models** toggle described below.

Limits are evaluated from recorded model usage, so [pricing configuration](#model-pricing) affects token-cost limits directly. Read the [pricing caveat](#pricing-caveat) before relying on a limit for billing-critical enforcement.

### Scopes

The five scopes protect different things and are typically used together:

- **Organization** — shared platform-wide budget. Caps the cumulative spend across every caller in the org, including traffic from virtual API keys.
- **Team** — per-team budget. Caps cumulative spend in the team, including traffic from virtual API keys assigned to the team.
- **Agent** — per-agent budget on a single gateway or LLM proxy. Useful when one agent drives the bulk of an org's spend.
- **User (personal budget)** — caps an identifiable human's usage. Applies to the chat UI, their personal chat API keys, and personal-scope virtual API keys they own. Team- and org-scope virtual keys do not bill a user.
- **Virtual API Key** — caps the integration key itself, regardless of who calls it. Use this for external services (Vercel AI SDK, OpenWebUI, n8n, etc.) where you want a per-integration ceiling. A personal-scope virtual key additionally bills its owner under the user scope.

Who gets billed for a given request is summarised here:

| Caller | Billed user | Billed virtual key |
|---|---|---|
| Chat UI (signed-in session) | the current user | — |
| Chat API key, scope = personal | the key's owner | — |
| Chat API key, scope = team or org | nobody (shared key) | — |
| Virtual API key, scope = personal | the key's owner | the virtual API key itself |
| Virtual API key, scope = team or org | nobody (shared key) | the virtual API key itself |
| JWKS-authenticated external caller | the local user the JWT maps to (by email) | — |

A personal-scope virtual API key has a single declared owner, so its spend is charged to both the key and the owner — both budgets enforce on the same request. Team- and org-scope virtual API keys are shared credentials with no single human owner, so only the virtual-API-key, team, and organization budgets apply to their traffic.

Per-user enforcement relies on a trusted identity:

- Chat UI sessions identify the signed-in user.
- Personal chat API keys identify their owner.
- Personal-scope virtual API keys identify their owner.
- JWKS-authenticated external callers are identified by the JWT, mapped to a local user by email.
- Team- and org-scope virtual API keys and raw provider keys carry no identifiable user, so their traffic does not consume user-scope budgets.

### Applies to all models

When configuring a token-cost limit, toggle **Apply to all models** to make the limit cover every model, including models added later. This is mutually exclusive with a concrete model list — pick one or the other.

Use all-models when you want a blanket ceiling. Use a concrete model list when one model has significantly different pricing or you want to cap a particular family only. Model-scoped limits are independent: exhausting a Claude-only limit does not block OpenAI requests.

### Pricing caveat

If a model has no pricing configured, Archestra falls back to a default tier (~$30–$50 per million tokens). Budget accuracy in that state is best-effort — the fallback can significantly over- or under-count real spend, and a token-cost limit that relies on it may fire too early or too late. Configure pricing explicitly at **Token Price** (under LLM → Costs) before relying on token-cost limits for critical enforcement.

### Rolling vs calendar resets

Limits reset on a **rolling window** driven by the organization-wide [limit cleanup interval](#limit-cleanup), not on a calendar boundary. A monthly cap resets 30 days after the last reset, not on the 1st of the month. Calendar-aligned resets (first of the month, start of the week, etc.) are not currently supported.

## Limit Cleanup

Limit usage is periodically reset according to the configured cleanup interval. This is an operational setting, not a retention policy. It controls how often expired or completed limit windows are cleaned up so counters stay accurate and limit storage does not grow unnecessarily.

Use shorter intervals if you rely on tighter reset windows and want counters refreshed more aggressively.

## Model Pricing

Model pricing is configured on the provider model settings pages. Pricing is the foundation for every cost feature in Archestra:

- statistics use it to convert token counts into spend
- token-cost limits use it to decide when a budget is reached
- optimization reports use it to calculate savings
- TOON compression savings are reported in dollars using the configured model price

If you use custom or self-hosted models, add pricing explicitly so cost reporting stays meaningful.

## Optimization Rules

Optimization rules reduce cost before a request is sent to an LLM. They evaluate request context and can switch the request to a lower-cost model when the rule conditions match.

Typical uses:

- route short prompts to a cheaper model
- use a less expensive model when tool use is not required
- apply time-based policies for predictable traffic patterns

Rules are applied by priority order. This makes them useful for layered policies, where a specific exception should win over a general fallback.

## TOON Compression

TOON compression reduces the token footprint of structured tool results before they are passed to the model. Archestra keeps the original JSON for application logic, then converts the model-facing representation to TOON when compression is enabled and when the converted form is actually smaller.

TOON is a compact, lossless representation of the JSON data model designed for LLM input. Its main advantage is with uniform arrays of objects, where repeated field names are declared once and row values are emitted in a table-like form. In practice, this is useful for tool outputs like:

- database query results
- lists of API resources
- analytics rows
- search results with repeated fields

Compression is skipped when:

- TOON is disabled
- a response has no tool results
- the TOON version would not save tokens

Archestra records before/after token counts and savings when compression is applied, so those savings appear in logs and aggregate cost reporting.

You can enable TOON compression at:

- organization level for all traffic
- team level when only certain teams should use it

See the upstream TOON format project for the format specification and benchmarks: [toon-format/toon](https://github.com/toon-format/toon).

## Related Documentation

- [Dual LLM Agent](platform-dual-llm)
- [Tool Policy Configuration Agent](platform-built-in-agents-policy-config)
- [Profiles Configuration](platform-profiles)
- [Observability](platform-observability)
- [Deployment](platform-deployment)
