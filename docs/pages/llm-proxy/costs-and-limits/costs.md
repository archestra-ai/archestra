---
title: Costs
description: Break down organization-wide API spend, subscription usage, tokens, and requests by credential, team, agent, model, person, app, skill, or label
order: 1
lastUpdated: 2026-11-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Open **Costs & Limits → Costs** to see where your organization's model spend, tokens, and requests go across virtual keys, teams, agents, models, people, apps, skills, and custom labels. Viewing organization-wide costs requires [`llmCost:read`](/docs/reference/permissions#llmCost:read). Team admins without it see [their teams' costs](#view-your-teams-costs).

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

In the explorer’s **Show** menu, choose **Cache reads**, **Cache writes**, or **Net cache savings**. The **Cache reads by model** and **Cache savings over time** presets open these views directly.

On **Costs**, cache tokens include all billing modes. Net savings cover metered usage only and are available **by Time** across the organization.

On **My Usage**, cache tokens can be grouped by model, client, or time. Net savings and cache cost are available **by All usage**, valued at API rates including subscription-covered usage; they have no timeline or per-model savings breakdown. These estimates are not subscription bill credits.

Savings compare cached input with full input pricing after cache-write surcharges, so they can be negative. Figures depend on provider-reported usage and available pricing.

## Slice Usage in the Cost Explorer

<span id="proxy-cost-attribution"></span><span id="per-user-usage"></span><span id="per-app-cost"></span><span id="per-skill-cost"></span>

Below the headline cards, use the cost explorer to break down usage by any dimension or start from a preset **View**:

1. Choose **Show** to pick the metric: **Billed spend**, **Subscription estimate**, **Requests**, **Tokens**, **Cache reads**, **Cache writes**, **Net cache savings**, **Tool calls**, **App runs**, or **Skill activations**.
2. Choose **by** to group rows by **Credential** (virtual key, OAuth client, or other sign-in), **Team**, **Agent**, **Model**, **Provider**, **Person**, **App**, **Skill**, **MCP server**, **MCP tool**, or **Label**.
3. Optionally choose **split by** to break each row down by a second dimension. **Team**, **Agent**, **Person**, **Credential**, **Provider**, and **Model** split by each other, so you can see who uses each agent, or which models each team used and what they cost. The **Tokens by agent and person** and **Spend by team and model** presets open two of these.

Switch between **Summary** (ranked totals, share of total, and period-over-period trend) and **Pivot** (a heat-shaded matrix with time buckets or split values as columns). Click any row to isolate it in the chart, click **Export CSV** to download the current table, or click **Show ... limits** in the toolbar to jump to [Limits](/docs/llm-proxy/costs-and-limits/limits) filtered to the selected scope or row.

## Group Proxy Costs by Label

<span id="attributing-external-proxy-traffic"></span>

When external gateways, CI jobs, or backend services call the [LLM Proxy](/docs/llm-proxy) with a [Virtual Key](/docs/llm-proxy/authentication#standard-virtual-keys) or [OAuth Client](/docs/llm-proxy/authentication#oauth-clients), tag those credentials with `key=value` labels (such as `cost_center=engineering` or `env=staging`) to group their spend in the explorer.

Label attribution resolves on each request in this order:

1. Labels on the authenticated **Virtual Key** or **OAuth Client** take priority.
2. If the credential does not set a given label key, the request inherits that key from its billing **Team**.
3. Labels are captured when the request starts, so editing a key's or team's labels later does not rewrite past cost reports.

In **Costs & Limits → Costs**, set **by** to **Label** and pick a label key (defaults to `cost_center`), or choose the **Spend by label** preset view. Requests without the selected label key appear under **Unlabeled**.

## View Your Own Usage

<span id="my-usage"></span>

Anyone signed in to Archestra can open **My Usage** in the sidebar to see their own personal spend, subscription estimate, requests, and tokens without needing [`llmCost:read`](/docs/reference/permissions#llmCost:read). It offers the same date range picker, chart, and explorer controls—grouped by **Agent**, **Model**, **Provider**, **Credential**, **Access method**, **App**, or **Skill**—scoped to calls attributed to your account.

![My Usage showing personal spend, tokens, requests, and usage breakdown](/docs/automated_screenshots/llm-proxy_my-usage.webp)

## View Your Teams' Costs

A team admin can check what their teams spend against their limits without seeing the rest of the organization. Open **Costs & Limits → Costs**: without [`llmCost:read`](/docs/reference/permissions#llmCost:read), the page covers only the teams you administer and their child teams.

- **Team** narrows the page to one of your teams when you administer more than one.
- **by** groups usage by **Time**, **Team**, or **Model**, without a further breakdown.
- **Show** offers every metric except the subscription estimate, which appears only in the summary at the top.

What to know:

- A request counts for a team the way its [team limits](/docs/llm-proxy/costs-and-limits/limits#team-limits-and-spend) count it: billed to the team or one of its child teams, or made by a member through an agent shared with the team.
- Totals count each request once, even when it counts for both a team and its parent. A parent's row includes its child teams' usage, so rows can add up to more than the total.
- Agent sharing, team membership, and which team is a child of which are read as they are now. Changing any of them, including moving a team under another parent, changes past figures here. A limit keeps the usage it already counted.

## What to Know

- **A split exports every metric:** the CSV of a split **Summary** has one line per row and split value, with requests, tokens, billed spend, and subscription estimate side by side.
- **Query the same data via API:** the footer of the cost explorer shows the exact request behind the current view, so you can copy it for scripts or internal billing pipelines. [`GET /api/statistics/llm-usage`](/docs/reference/api/operations#tag/statistics/GET/api/statistics/llm-usage) groups requests, tokens, and spend by any mix of day, team, credential, provider, and model.
- **Export to Prometheus and Grafana:** for real-time scraping and alerting, use the LLM cost and token counters in [Prometheus Metrics](/docs/admin/observability/metrics/llm).
