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

Usage limits are guardrails for LLM spend. Archestra supports token-cost limits scoped to the organization, a team, an agent, a specific user, or a specific virtual API key. Each limit targets one or more specific models — or every model, using the all-models sentinel described below.

Limits are evaluated from recorded model usage, so [pricing configuration](#model-pricing) affects token-cost limits directly. Read the [pricing caveat](#pricing-caveat) before relying on a limit for billing-critical enforcement.

### Scopes

The five scopes protect different things and are typically used together:

- **Organization** — shared platform-wide budget. Caps the cumulative spend across every caller in the org, including virtual-key traffic.
- **Team** — per-team budget. Caps cumulative spend in the team, including virtual-key traffic from the team's keys.
- **Agent** — per-agent budget on a single gateway or LLM proxy. Useful when one agent drives the bulk of an org's spend.
- **User (personal budget)** — caps an identifiable human's usage of the chat UI and their personal chat API keys. It does NOT apply to virtual-key traffic, even if the key was created by that user — see the billing table below.
- **Virtual API Key** — caps the shared integration key itself, regardless of who calls it. Use this for external services (Vercel AI SDK, OpenWebUI, n8n, etc.) where you want a per-integration ceiling.

Who gets billed for a given request is summarised here:

| Caller | Billed user | Billed virtual key |
|---|---|---|
| Chat UI (signed-in session) | the current user | — |
| Chat API key, scope = personal | the key's owner | — |
| Chat API key, scope = team or org | nobody (shared key) | — |
| Virtual API key (any scope) | nobody (shared key) | the vkey itself |
| JWKS-authenticated external caller | the local user the JWT maps to (by email) | — |

Important: virtual-key traffic never bills a user — not even the user who created the key. A virtual key is a shared credential; the individual humans calling through it are not identifiable to Archestra, so user-scope budgets cannot be enforced on that traffic. Use a virtual-key-scope budget to cap the key itself, or a team/organization-scope budget to cap the surrounding group.

Per-user enforcement is only authoritative when the caller's identity is derived from a trusted signal:

- For in-UI chat traffic, the chat route derives the billed user from the scope of the resolved chat-api-key (personal → key owner; team/org → nobody) and propagates that to the LLM proxy over a loopback-only internal channel. External callers reaching the proxy over the network cannot influence this signal.
- For external API traffic, the JWT from a JWKS-authenticated provider is the authoritative signal.
- Virtual API keys and raw provider keys carry no identifiable billed user, so their traffic does not consume user-scope budgets.

### Applies to all models

When configuring a token-cost limit, toggle **Apply to all models** to make the limit cover every model, including models that get configured later. Under the hood this stores the limit with a `["*"]` model array (the all-models sentinel) and enforcement counts spend from every incoming model against it. Mixing `"*"` with concrete model names is rejected.

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
