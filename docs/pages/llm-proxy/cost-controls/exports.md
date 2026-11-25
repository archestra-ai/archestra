---
title: Export Costs
description: Get LLM spend and usage into spreadsheets, scripts, and FinOps tools as one-off downloads, API queries, or scheduled FOCUS files in your own bucket
order: 2
lastUpdated: 2026-11-24
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Put Archestra's LLM spend next to the rest of your cloud bill. Finance gets the same numbers as the Costs page, split by team, agent, model, and person, without anyone copying them by hand.

There are three ways, from quickest to most automated:

- **Download a view:** a one-off CSV, JSON, or Parquet file of what the cost explorer shows.
- **Query the API:** pull the same numbers from a script or pipeline on your own schedule.
- **Schedule exports:** Archestra writes a [FOCUS](https://focus.finops.org/) file for every hour or day into your own bucket. Most of this page covers this way.

## Download a View

Open **Costs**, set up the [cost explorer](/docs/insights/costs#slice-usage-in-the-cost-explorer) view you want, then click **Export** above its table and pick **CSV**, **JSON**, or **Parquet**. The file holds the table as it is on screen, for the selected date range.

- A split **Summary** exports every metric: one line per row and split value, with requests, tokens, billed spend, and subscription estimate side by side.

## Query the API

Script the same numbers when a scheduled file does not fit, such as a nightly job that loads them into your own billing system. The footer of the cost explorer shows the exact request behind the current view, so you can copy it.

- [`GET /api/statistics/llm-usage`](/docs/reference/api/operations#tag/statistics/GET/api/statistics/llm-usage) groups requests, tokens, and spend by any mix of day, team, agent, person, credential, provider, and model.
- Send an [API key](/docs/reference/api#authentication) in the `Authorization` header. The key sees what its owner can see, so organization-wide figures need [`llmCost:read`](/docs/reference/permissions#llmCost:read).

## Schedule Exports to Object Storage

Archestra exports LLM cost and usage data in FOCUS, the open format for billing data. AWS, Azure, and Google Cloud export their bills in it too, so you can track LLM spend together with the rest of your costs. Files go to a [blob provider](/docs/admin/blob-providers): an Amazon S3 or Google Cloud Storage bucket, or an Azure Blob Storage container.

You can configure an export on the **Costs & Limits → FinOps Export** page.

### How It Works

<span id="where-files-land"></span>Depending on how it is configured, an export writes one file per day or one per hour:

- Daily: `year=2026/month=11/day=10/archestra-focus-2026-11-10.csv`
- Hourly: `year=2026/month=11/day=10/archestra-focus-2026-11-10T14.csv`

<span id="when-files-are-written"></span>A file arrives about 15 to 20 minutes after its day or hour ends. If a file is written again, it replaces the old one.

<span id="what-each-row-holds"></span>Each file is a FOCUS 1.2 CSV, which tools such as Athena, BigQuery, and DuckDB read as a table. A row is one hour of usage by one person, through one agent, on one model.

| FOCUS column | Holds |
| --- | --- |
| `BilledCost`, `EffectiveCost` | Billed spend in USD. `0` for [subscription traffic](/docs/llm-proxy/cost-controls#subscription-vs-metered-cost), which the provider does not bill per token. |
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
