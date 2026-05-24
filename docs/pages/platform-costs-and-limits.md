---
title: Costs & Limits
category: LLM Proxy
order: 4
lastUpdated: 2026-05-14
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

Usage limits are guardrails for LLM spend. Archestra supports token-cost limits scoped to the organization, team, user, agent, LLM proxy, or virtual API key. Each limit can target one or more specific models, or apply to all models. A limit with no model specified acts as a global budget across every model the entity uses. Each limit has its own cleanup interval.

| Scope | Use when |
| --- | --- |
| Organization | You need a shared platform-wide budget. |
| Team | Different groups need separate spend caps. |
| User | Individual users need their own budgets. |
| Agent or LLM proxy | A specific profile needs a budget. |
| Virtual API key | Spend should be capped per API key. |

Limits are evaluated from recorded model usage, so pricing configuration affects token-cost limits directly.

## Default User Limits

Admins can configure a default user limit in LLM settings. It applies to every current and future user.

A custom per-user limit overrides the default for that user. Use this when one user needs a different budget.

## Limit Cleanup

Limit usage is reset according to each limit's cleanup interval. New limits default to weekly cleanup unless an admin chooses a different interval.

Default user limits use their own cleanup interval from LLM settings.

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
