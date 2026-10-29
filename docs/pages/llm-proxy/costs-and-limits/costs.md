---
title: Costs
description: Break down organization-wide API spend, subscription usage, tokens, and requests by key, team, agent, model, person, app, skill, or label
order: 1
lastUpdated: 2026-10-28
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Open **Costs & Limits → Costs** to see where your organization's model spend, tokens, and requests go across virtual keys, teams, agents, models, people, apps, skills, and custom labels. Viewing organization-wide costs requires [`llmCost:read`](/docs/reference/permissions#llmCost:read).

![Costs & Limits → Costs showing headline totals and the cost explorer](/docs/automated_screenshots/llm-proxy_costs.webp)

<span id="track-spending"></span><span id="statistics"></span>

## Headline Totals

Pick a time range in the top-right corner (**Today**, **Last 7 days**, **Last 30 days**, **Last 90 days**, or **Custom**). Five summary cards at the top of the page update for that window:

- **API spend:** metered charges from per-token API keys.
- **Subscription usage estimate:** what calls through flat-rate subscriptions would have cost at list API rates (see [Subscription vs Metered Cost](/docs/llm-proxy/costs-and-limits#subscription-vs-metered-cost)).
- **Requests:** total model calls in the selected period.
- **Tokens:** newly processed input and output tokens (including cache writes; reused cached input is shown separately and does not add to the total).
- **Active people:** distinct users who ran a model call in the period.

## Review Prompt Caching

In the explorer’s **Show** menu, choose **Cache reads**, **Cache writes**, or **Net cache savings**. The **Cache reads by model** and **Prompt cache savings** presets open these views directly.

On **Costs**, cache tokens include all billing modes. Net savings cover metered usage only and are available **by Time** across the organization.

On **My Usage**, cache tokens can be grouped by model, client, or time. Net savings and cache cost are available **by All usage**, valued at API rates including subscription-covered usage; they have no timeline or per-model savings breakdown. These estimates are not subscription bill credits.

Savings compare cached input with full input pricing after cache-write surcharges, so they can be negative. Figures depend on provider-reported usage and available pricing.

## Slice Usage in the Cost Explorer

<span id="proxy-cost-attribution"></span><span id="per-user-usage"></span><span id="per-app-cost"></span><span id="per-skill-cost"></span>

Below the headline cards, use the cost explorer to break down usage by any dimension or start from a preset **View**:

1. Choose **Show** to pick the metric: **Billed spend**, **Subscription estimate**, **Requests**, **Tokens**, **Cache reads**, **Cache writes**, **Net cache savings**, **Tool calls**, **App runs**, or **Skill activations**.
2. Choose **by** to group rows by **Virtual key**, **Team**, **Agent**, **Model**, **Provider**, **Person**, **App**, **Skill**, **MCP server**, **MCP tool**, or **Label**.
3. Optionally choose **split by** to break each row down by a second dimension, such as **Team** split by **Model** or **Label** split by **Team**.

Switch between **Summary** (ranked totals, share of total, and period-over-period trend) and **Pivot** (a heat-shaded matrix with time buckets or split values as columns). Click any row to isolate it in the chart, click **Copy as CSV** to export the current table, or click **Show ... limits** in the toolbar to jump to [Limits](/docs/llm-proxy/costs-and-limits/limits) filtered to the selected scope or row.

## Group Proxy Costs by Label

<span id="attributing-external-proxy-traffic"></span>

When external gateways, CI jobs, or backend services call the [LLM Proxy](/docs/llm-proxy) with a [Virtual Key](/docs/llm-proxy/authentication#standard-virtual-keys) or [OAuth Client](/docs/llm-proxy/authentication#oauth-clients), tag those credentials with `key=value` labels (such as `cost_center=engineering` or `env=staging`) to group their spend in the explorer.

Label attribution resolves on each request in this order:

1. Labels on the authenticated **Virtual Key** or **OAuth Client** take priority.
2. If the credential does not set a given label key, the request inherits that key from its billing **Team**.
3. Labels are captured when the request starts, so editing a key's or team's labels later does not rewrite past cost reports.

In **Costs & Limits → Costs**, set **by** to **Label** and pick a label key (defaults to `cost_center`), or choose the **Spend by cost center** preset view. Requests without the selected label key appear under **Unlabeled**.

## View Your Own Usage

<span id="my-usage"></span>

Anyone signed in to Archestra can open **My Usage** in the sidebar to see their own personal spend, subscription estimate, requests, and tokens without needing [`llmCost:read`](/docs/reference/permissions#llmCost:read). It offers the same date range picker, chart, and explorer controls—grouped by **Agent**, **Model**, **Provider**, **Virtual key**, **Access method**, **App**, or **Skill**—scoped to calls attributed to your account.

![My Usage showing personal spend, tokens, requests, and usage breakdown](/docs/automated_screenshots/llm-proxy_my-usage.webp)

## What to Know

- **Query the same data via API:** the footer of the cost explorer shows the exact [`GET /api/statistics/costs`](/docs/reference/api#/Statistics/getCostStatistics) or [`GET /api/statistics/llm-proxy`](/docs/reference/api#/Statistics/getProxyCostStatistics) request behind the current view so you can copy it for scripts or internal billing pipelines.
- **Export to Prometheus and Grafana:** for real-time scraping and alerting, use the LLM cost and token counters in [Prometheus Metrics](/docs/admin/observability/metrics/llm).
