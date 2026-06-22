---
title: Costs & Limits
category: LLM Proxy
order: 4
lastUpdated: 2026-06-22
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
- prompt caching that reuses an unchanged request prefix instead of reprocessing it each turn

## Usage Limits

Usage limits are guardrails for LLM spend. Archestra supports token-cost limits scoped to the organization, team, user, agent, LLM proxy, virtual API key, or environment. Each limit can target one or more specific models, or apply to all models. A limit with no model specified acts as a global budget across every model the entity uses. Each limit has its own cleanup interval.

| Scope | Use when |
| --- | --- |
| Organization | You need a shared platform-wide budget. |
| Team | Different groups need separate spend caps. |
| User | Individual users need their own budgets. |
| Agent or LLM proxy | A specific profile needs a budget. |
| Virtual API key | Spend should be capped per API key. |
| Environment | A deployment environment (for example, production) needs its own combined budget across all users. |

An environment-scoped limit caps total spend across every user whose agent runs in that environment. A request's environment is resolved from its agent's assigned environment; requests through an agent with no environment are not subject to environment-scoped limits.

Limits are evaluated from recorded model usage, so pricing configuration affects token-cost limits directly.

## Default User Limits

Admins can configure a default user limit in LLM settings. It applies to every current and future user.

You can also set per-environment default user limits in LLM settings — for example, a smaller per-user cap in production than in development. When a request runs in an environment that has a per-environment default, that default applies (counting only the user's usage within that environment) and replaces the org-wide default for that request. Environments without a per-environment default fall back to the org-wide default.

A custom per-user limit overrides both the org-wide and per-environment defaults for that user. Use this when one user needs a different budget.

## Limit Cleanup

Each limit has its own cleanup interval. Rolling intervals reset after elapsed time. Calendar intervals reset at the next day, week, or month boundary; weekly intervals can start on Sunday or Monday. Changing a limit's cleanup interval resets its current usage.

Default user limits use their own cleanup interval from LLM settings.

## Model Pricing

Model pricing is configured on the provider model settings pages. Pricing is the foundation for every cost feature in Archestra:

- statistics use it to convert token counts into spend
- token-cost limits use it to decide when a budget is reached
- optimization reports use it to calculate savings
- TOON compression savings are reported in dollars using the configured model price

When you add a provider, Archestra syncs known input, output, and cache prices from a public model registry. You can override any of these per model, including cache read and write prices. A model the registry does not recognize falls back to an estimated flat price, shown as "estimated" in the model editor — set a custom price so cost reporting stays accurate. Amazon Bedrock and Azure model ids do not match the registry directly, so Archestra maps them back to the underlying vendor model to recover real prices (including cache prices) where possible.

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

## Prompt Caching

Prompt caching lets a provider reuse the unchanging prefix of a request, such as the system prompt, tool definitions, and earlier turns, instead of reprocessing it on every turn. Reused tokens are billed at a fraction of the input price, which matters most for agents with a long system prompt or many tools. The first request to cache a prefix pays a small write surcharge, while later requests that reuse it pay far less, so a multi-turn conversation is a net saving.

Anthropic and Amazon Bedrock require explicit cache markers, which Archestra adds to the stable prefix and the most recent turn; OpenAI, Gemini, and DeepSeek cache eligible prefixes on their own. Caching applies automatically wherever the provider and model support it. Archestra records cache read and write token counts and the resulting savings, so they appear in logs and aggregate cost reporting.

Cache cost uses the model's cache read and write prices when those are known (synced from the registry or set by an admin); otherwise it is estimated from the input price. Configure cache prices per model in the model editor for accurate caching costs.
