---
title: Costs & Limits
description: Track LLM spend by team, agent, model, and person, and set usage limits
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra records the cost of every model request from chat, agents, and the [LLM Proxy](/docs/llm-proxy). Use it to:

- See spend by person, team, agent, app, and model.
- Set budgets that block requests when spend reaches the limit.
- See how much use your Claude and ChatGPT subscriptions cover.

![Costs & Limits → Costs for the last 30 days: billed spend, subscription-covered use, requests, tokens, and daily cost and cache-savings charts](/docs/automated_screenshots/llm-proxy_costs.webp)

<span id="statistics"></span><span id="see-costs"></span>

## Track Spending

**Costs** shows the whole company's spend. **My Usage** shows each person their own.

### Company Spend

Go to **Costs & Limits → Costs** and pick a timeframe. You need [`llmCost:read`](/docs/reference/permissions#llmCost:read). The top shows billed spend, subscription use, requests, and tokens. Each section below answers one question:

| Section | Answers | Watch out |
| --- | --- | --- |
| **LLM Proxy** | Which key or app spent it? | A shared key names no person. Requests with no known sign-in show as unknown. |
| **People** | Who uses AI the most? | Subscription use bills $0, so compare requests and tokens. To see other people, you also need access to the member list. |
| **Apps** | What did an [app](/docs/chat/apps) cost to build and run? | When one chat built several apps, each app shows the chat's full cost. Savings are estimates. |
| **Skills** | What do turns with a [skill](/docs/agents/skills) cost? | A turn's cost covers the whole conversation, so skills can overlap. |

Team, agent, and model views are there too.

<span id="proxy-cost-attribution"></span><span id="per-user-usage"></span><span id="per-app-cost"></span><span id="per-skill-cost"></span><span id="attributing-external-proxy-traffic"></span>

To tie proxy traffic to a person, use a credential that names one. See [Authentication](/docs/llm-proxy/authentication#attribution-in-logs).

<span id="my-usage"></span>

### Your Own Usage

Click your name in the sidebar, then **My Usage**. It shows your billed spend, requests, tokens, and active days, by model and by client.

![My Usage for the last 30 days: spend, requests, tokens, and active days, with the models and clients used](/docs/automated_screenshots/llm-proxy_my-usage.webp)

- **Where your tokens went** splits fresh input, cache reads, cache writes, and output.
- **Costliest sessions** lists your most expensive sessions.

<span id="usage-limits"></span>

## Set a Budget

A limit blocks matching requests once spend reaches it. Requests run again when the limit resets, or when you raise it.

1. Go to **Costs & Limits → Limits** and click **Add Limit**.
2. Choose who it applies to: organization, team, user, agent, LLM Proxy, virtual key, or environment.
3. Pick models, or **All models**.
4. Enter **Limit value ($)**, choose the **Cleanup interval**, and click **Create limit**.

The table shows each limit's use so far, and when it resets.

![Costs & Limits → Limits, with monthly budgets for the organization, two teams, and the production environment](/docs/automated_screenshots/llm-proxy_limits.webp)

<span id="default-user-limits"></span><span id="limit-cleanup"></span>

- **A budget for everyone:** set a default per-user limit under **Settings → LLM**. A per-environment default replaces it in that environment. A user's own limit replaces both.
- **Resets:** a rolling interval resets after the time passes. A calendar interval resets at the next day, week, or month. A week can start on Sunday or Monday. Changing the interval resets the current use.
- **Environment limits** add up the agents in that environment. Agents with no environment do not count.
- **Subscription use never counts** toward a limit.
- A blocked request gets HTTP `402`, with `code: token_cost_limit_exceeded`. The message says Archestra blocked it, not the provider. SDKs do not retry a `402`.
- Archestra checks before each request. The request that crosses the limit still runs, so spend can end a little above it.

<span id="subscription-vs-metered-cost"></span>

## Subscription vs Metered Cost

See what your Claude and ChatGPT subscriptions save. A developer on Claude Max runs Claude Code all day. That use bills $0, but Costs shows what the same tokens would cost at API prices. That figure is the saving.

Archestra tells the two apart from the credential on each request. You configure nothing:

| Credential | Counted as |
| --- | --- |
| A Claude Pro or Max sign-in, such as Claude Code's | Subscription |
| A ChatGPT sign-in, from Codex or **Connect** on Model Providers | Subscription |
| A SuperGrok sign-in | Subscription |
| Any API key, including GitHub Copilot and Microsoft 365 Copilot sign-ins | Metered |

- Subscription use bills $0 and never counts toward a [budget](#set-a-budget). Costs shows it as **Subscription-covered**.
- A Claude subscription that runs into paid usage credits turns metered. Archestra reads this from Anthropic's response headers.
- To count every new request as metered, set [`ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT=false`](/docs/reference/configuration#ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT). Past requests keep their classification.

<span id="model-pricing"></span><span id="prompt-caching"></span><span id="get-accurate-numbers"></span><span id="where-prices-come-from"></span>

## Where Token Prices Come From

Every cost uses the model's price. Archestra syncs input, output, and cache prices for known models. A model it does not know gets an estimated price. For a custom or self-hosted model, set the price yourself. See [Model Pricing, Limits, and Modalities](/docs/llm-proxy/providers#model-pricing-limits-and-modalities).

Prompt caching lowers the cost of a prompt that starts the same way each time. Costs and logs show the cache reads and writes the provider reports. Archestra adds cache points to its own chat and agent requests. Proxy requests keep the caller's own cache markers.

## What to Know

- **Need the raw numbers?** Get them per person from [`GET /api/statistics/users`](/docs/reference/api#/Statistics/getUserStatistics), or your own from [`GET /api/statistics/me`](/docs/reference/api#/Statistics/getMyStatistics).
- **Already use Prometheus or Grafana?** Archestra exports cost and token metrics, so you can chart spend next to your other dashboards. See [Metrics](/docs/admin/observability/metrics#llm-metrics).
