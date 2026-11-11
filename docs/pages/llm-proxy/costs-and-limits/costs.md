---
title: Costs
description: Break down organization-wide API spend, subscription usage, tokens, and requests by credential, team, agent, model, person, app, skill, or label, and export them to your own bucket
order: 1
lastUpdated: 2026-11-10
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

Switch between **Summary** (ranked totals, share of total, and period-over-period trend) and **Pivot** (a heat-shaded matrix with time buckets or split values as columns). Click any row to isolate it in the chart, click **Export** to download the current table as CSV, JSON, or Parquet, or click **Show ... limits** in the toolbar to jump to [Limits](/docs/llm-proxy/costs-and-limits/limits) filtered to the selected scope or row.

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

## Export Costs to Object Storage

Schedule a file of every hour's or day's model spend into your own bucket, so your FinOps tools show Archestra's LLM costs next to your cloud bill. Each file is a CSV in [FOCUS 1.2](https://focus.finops.org/), the FinOps Foundation's open format for cost and usage data, which tools such as Athena, BigQuery, and DuckDB read as a table.

Before you start, add a [blob provider](/docs/admin/blob-providers) for the bucket. Viewing exports requires [`llmCost:read`](/docs/reference/permissions#llmCost:read) and [`organizationSettings:read`](/docs/reference/permissions#organizationSettings:read). Adding, changing, or running one also requires [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

1. Open **Costs & Limits → Exports** and add an export.
2. Name it and pick the blob provider.
3. Choose the schedule: **Hourly** writes one file per hour, **Daily** one file per UTC day.
4. Optionally change the path prefix, `cost-exports` by default.
5. Save, then click **Run now** to write a file right away and check the pipeline.

The export's row shows the last run's status and the key of the last file written. A failed run shows the storage error. See [Fix a Failed Test](/docs/admin/blob-providers#fix-a-failed-test) for what each error means.

### Where Files Land

Each period is one file, under the blob provider's key prefix, then the export's path prefix:

```text
<provider prefix>/cost-exports/year=2026/month=11/day=10/archestra-focus-2026-11-10.csv
<provider prefix>/cost-exports/year=2026/month=11/day=10/archestra-focus-2026-11-10T14.csv
```

The first line is a daily file and the second an hourly file for 14:00 to 15:00 UTC. The `year=`, `month=`, and `day=` folders are Hive-style partitions, so a query that filters by date reads only the matching files.

### When Files Are Written

Archestra writes a period once it has been over for 15 minutes, so requests still running at its end are counted. Expect each file about 15 to 20 minutes after its hour or day ends.

- Scheduled runs start with the period in progress when you create the export.
- **Run now** writes every period that is due. When none is due, it rewrites the latest completed period.
- A period always goes to the same key. A rerun or retry overwrites its file, so a period is never in two files.
- When runs are missed or a write fails, the next run writes every period since the last file, up to 48 periods at a time.

### What Each Row Holds

Each row is one hour of usage for one combination of provider, model, billing mode, team, agent, app or Knowledge connector, and person. Archestra does not bill model usage: the provider does, so the provider is the row's vendor and your organization is the billing account.

| FOCUS column | Holds |
| --- | --- |
| `BilledCost`, `EffectiveCost` | Billed spend in USD. `0` for [subscription traffic](/docs/llm-proxy/costs-and-limits#subscription-vs-metered-cost), which the provider does not bill per token. |
| `ListCost` | Archestra's list-price estimate for every request, including subscription traffic. |
| `ProviderName`, `PublisherName`, `InvoiceIssuerName` | The model provider, such as Anthropic or OpenAI. |
| `BillingAccountId`, `BillingAccountName` | Your Archestra organization. |
| `SubAccountId`, `SubAccountName` | The billing team. Empty when the request has none. |
| `ResourceId`, `ResourceName`, `ResourceType` | The agent, LLM proxy, MCP gateway, app, or Knowledge connector that made the request. |
| `SkuId` | The model. |
| `ConsumedQuantity` | Input plus output tokens. |
| `ChargePeriodStart`, `ChargePeriodEnd` | The hour, in UTC. The billing period is the calendar month. |
| `Tags` | JSON with `archestra:billing-mode`, `archestra:provider-api`, and, when known, `archestra:team`, `archestra:user`, and `archestra:resource`. |

Archestra-specific columns start with `x_`, as FOCUS reserves for custom columns: `x_BillingMode`, `x_InputTokens`, `x_OutputTokens`, `x_CacheReadTokens`, `x_CacheWriteTokens`, `x_Requests`, `x_ProviderApi`, `x_UserId`, and `x_UserEmail`.

What to know:

- Files name each person by email. Limit who can read the bucket accordingly.
- To sum spend, add `BilledCost`. Adding `ListCost` counts subscription traffic at list price.
- Changing the schedule never writes an hour twice. After a switch from hourly to daily, the rest of the current day is written as hourly files, and daily files start at the next midnight UTC.

## What to Know

- **A split exports every metric:** the CSV of a split **Summary** has one line per row and split value, with requests, tokens, billed spend, and subscription estimate side by side.
- **Query the same data via API:** the footer of the cost explorer shows the exact request behind the current view, so you can copy it for scripts or internal billing pipelines. [`GET /api/statistics/llm-usage`](/docs/reference/api/operations#tag/statistics/GET/api/statistics/llm-usage) groups requests, tokens, and spend by any mix of day, team, agent, person, credential, provider, and model.
- **Export to Prometheus and Grafana:** for real-time scraping and alerting, use the LLM cost and token counters in [Prometheus Metrics](/docs/admin/observability/metrics/llm).
