---
title: Costs & Limits
category: LLM Proxy
order: 4
lastUpdated: 2026-08-29
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra tracks personal and organization-wide LLM usage, enforces usage limits, and records savings from tool-result compression and prompt caching. Organization controls remain under **Costs & Limits**. Open **My Usage** from your user menu.

## Statistics

The **Costs** tab at `/llm/costs` is the organization-wide rollup for LLM traffic. It starts with billed spend, subscription-covered usage, request, and token totals, then breaks the same timeframe down by team, agent, LLM proxy, model, person, app, and skill. Use it to answer questions like:

- which teams are driving spend
- which models are responsible for the largest share of cost
- whether TOON compression and prompt caching are reducing spend over time

The **LLM Proxy** section reports one total rather than a list. There is a single LLM Proxy, so all of its traffic counts toward that one figure.

For a fuller cost view outside the Archestra UI, use Archestra's exported [metrics](platform-observability#metrics) and the prebuilt [Grafana dashboards](platform-observability#grafana-dashboards). Those surfaces are better suited for long-term monitoring, alerting, and cross-system cost analysis.

This page depends on model pricing being configured correctly. If a model has no pricing, usage can still be logged, but cost calculations will be incomplete.

Archestra stores both raw spend and savings. Savings can come from:

- TOON compression that reduces tool-result tokens before the result is sent to the model
- prompt caching that reuses an unchanged request prefix instead of reprocessing it each turn

Reading organization-wide costs requires the `llmCost:read` permission. You can still open **My Usage** from your user menu without it.

![Organization Costs showing billed spend, subscription-covered usage, requests, tokens, and cost trends](/docs/automated_screenshots/platform-costs-and-limits_costs.webp)

## My Usage

The **My Usage** page at `/llm/usage` shows your own activity: billed spend, requests, tokens, active days, and how spend moved over the selected timeframe. It then provides separate model and client tables with each entry's token share, requests, tokens, and cost.

The lower sections explain the shape of that usage:

- **Token mix** separates fresh input, cache reads, cache writes, and output.
- **Context size** groups requests by how much context the model received.
- **Top sessions** shows which sessions concentrated the most list-price usage, along with their dominant model and client.

Everyone can open **My Usage** from the user menu, between **Personal Settings** and **Sign Out**. It is separate from the **Costs** and **Limits** tabs. Limits remain available at `/llm/limits`.

![My Usage showing personal totals and detailed model and client usage tables](/docs/automated_screenshots/platform-costs-and-limits_my-usage.webp)

The same data is available from `GET /api/statistics/me` and `GET /api/statistics/me/breakdown`. Both endpoints report only the calling user's activity, so neither needs the organization-wide cost permission.

Your summary counts every request Archestra attributed to you in the current organization, whichever agent served it.

## Per-User Usage

The People section of the statistics view breaks usage down by person. For each user it shows requests, tokens, the models they use, how many days they were active, and their cost. Use it to see who has adopted AI, and which models they reach for.

A request only appears here when Archestra knows who made it. Identity comes from an authenticated credential — a [passthrough virtual key](platform-llm-proxy-authentication#passthrough-virtual-keys) or your identity provider. A request made with a shared credential and no user context is not attributed to anyone, so per-user totals read lower than org-wide totals when some traffic is unattributed.

Tokens and requests are the honest measure of adoption. Cost is not: a person whose traffic runs on a flat-rate subscription is billed nothing, however much they use. See [Subscription vs Metered Cost](#subscription-vs-metered-cost).

The same data is available from the API at `GET /api/statistics/users`, which returns one row per user with their email, so you can join it to an external roster. The response is paginated. Two options are off by default because each one costs extra work: `includeModels` adds the per-model breakdown, and `includeTimeSeries` adds a cost series per user.

Per-user usage is employee-level data. Seeing other people's usage requires permission to read the member list; without it, both the UI and the API show you only your own.

## Per-App Cost

The Apps section reports what each [MCP App](platform-apps) cost to build and what it costs to run.

Build cost is the LLM spend of the chat that authored the app. It is a one-off: you pay it once, then the app runs. An app created from the Apps page has no authoring chat, so it reports no build cost.

Runtime cost has two parts. Opening an app and using its interface costs nothing — the model is not in the loop. But an app can request a completion of its own with `archestra.llm.complete()`, and those calls are billed like any other. The Runs and Tool calls columns show how often the app was used; Runtime cost shows what its own LLM calls came to.

The estimate in the last two columns answers "was this app worth building". It assumes one run of an app replaces one chat session, priced at your organization's average cost per chat session over the same period. That average is measured from your own traffic and shown in the section description, so you can judge the assumption — an app that replaces a long research chat saves more than the average suggests, and one that replaces a two-message exchange saves less.

One chat can build several apps. When it does, the whole chat's spend is reported for each of them rather than divided, and the build cost is marked to say so.

The same data is available from the API at `GET /api/statistics/apps`.

## Per-Skill Cost

The Skills section reports what each [Agent Skill](platform-agent-skills) costs. A skill works by adding its instructions to the model's context, so it has two costs and they answer different questions.

Context tokens is the skill's own footprint: the tokens its instructions added, measured when they were injected. This is the number that belongs to the skill alone, and the one to look at when a skill feels expensive for what it does.

Cost on those turns is the spend of the turns that ran with the skill in context. Those turns carried the conversation as well as the skill, and two skills active in one chat are each credited with the same turns. Read it as an upper bound on the skill's influence, not as a bill.

The same data is available from the API at `GET /api/statistics/skills`.

## Subscription vs Metered Cost

Some LLM traffic is not billed per token. A flat-rate subscription — Claude Code on a Max or Pro plan, for example — covers usage for a fixed monthly fee. Pricing that traffic at per-token API rates would report a cost that was never charged.

Each interaction records a billing mode. Metered traffic is billed per token, so its cost is real spend. Subscription traffic is covered by the plan, so its billed spend is $0. Archestra still keeps the list-price estimate for subscription traffic, so you can see what the same usage would have cost at API rates.

The "Actual Cost" line and the per-team, per-agent, and per-model cost figures show billed spend. Subscription usage appears as a separate "Subscription (Not Billed)" line on the Costs chart and as a badge on the affected sessions.

Archestra initially detects the billing mode from the credential itself. Anthropic subscription logins (Claude Code on a Max or Pro plan, for example), ChatGPT subscription logins (Codex), and SuperGrok logins use credentials with a distinct format, so no configuration is needed.

Claude Max and Pro users can enable paid usage credits after their included allowance is exhausted. Anthropic identifies a successful response fulfilled from those credits in its rate-limit response headers. Archestra records that interaction as metered, because it is charged at API rates, while responses fulfilled from the plan remain subscription-covered. If those headers are missing or unfamiliar, Archestra keeps the credential-derived classification.

Turn detection off with `ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT=false` to treat all traffic as metered.

Detection applies to new interactions. Traffic recorded before detection existed stays metered.

Usage limits follow the same rule: subscription traffic does not count toward them. A limit only tracks usage that is billed.

## Usage Limits

Usage limits are guardrails for LLM spend. Archestra supports token-cost limits scoped to the organization, team, user, agent, LLM proxy, virtual API key, or environment. Each limit can target one or more specific models, or apply to all models. A limit with no model specified acts as a global budget across every model the entity uses. Each limit has its own cleanup interval.

| Scope | Use when |
| --- | --- |
| Organization | You need a shared platform-wide budget. |
| Team | Different groups need separate spend caps. |
| User | Individual users need their own budgets. |
| Agent or LLM proxy | A specific agent, or all LLM Proxy traffic, needs a budget. |
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
- savings reporting uses it to price what a request would otherwise have cost
- TOON compression savings are reported in dollars using the configured model price

When you add a provider, Archestra syncs known input, output, and cache prices from a public model registry. You can override any of these per model, including cache read and write prices. A model the registry does not recognize falls back to an estimated flat price, shown as "estimated" in the model editor — set a custom price so cost reporting stays accurate. Amazon Bedrock and Azure model ids do not match the registry directly. Archestra maps them back to the underlying vendor model to recover real prices — cache prices included — and the context window.

If you use custom or self-hosted models, add pricing explicitly so cost reporting stays meaningful.

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

A team-level opt-in works on its own. A team with compression enabled uses it even when the organization-wide setting is off. Choosing Disabled in LLM settings clears every team opt-in and turns compression off.

See the upstream TOON format project for the format specification and benchmarks: [toon-format/toon](https://github.com/toon-format/toon).

## Prompt Caching

Prompt caching lets a provider reuse the unchanging prefix of a request, such as the system prompt, tool definitions, and earlier turns, instead of reprocessing it on every turn. Reused tokens are billed at a fraction of the input price, which matters most for agents with a long system prompt or many tools. The first request to cache a prefix pays a small write surcharge, while later requests that reuse it pay far less, so a multi-turn conversation is a net saving.

Anthropic and Amazon Bedrock need an explicit cache marker in the request. Archestra adds one to chat conversations, marking the stable prefix and the most recent turn. Every other path forwards the markers its caller set, unchanged. That covers requests your own clients send through the LLM Proxy, and agent runs over A2A — which set no marker of their own, so they go uncached unless the caller adds one. OpenAI, Gemini, and DeepSeek cache eligible prefixes on their own, with no marker at all. Archestra records cache read and write token counts and the resulting savings, so they appear in logs and aggregate cost reporting. Caching on Bedrock has model and lifetime limits of its own — see [Supported LLM Providers](/docs/platform-supported-llm-providers#prompt-caching).

Cache cost uses the model's cache read and write prices when those are known (synced from the registry or set by an admin); otherwise it is estimated from the input price. Configure cache prices per model in the model editor for accurate caching costs.
