---
title: Export Costs
description: Get LLM spend and usage into spreadsheets, scripts, and FinOps tools as one-off downloads, API queries, or scheduled FOCUS files in your own bucket
order: 3
lastUpdated: 2026-11-11
---

Put Archestra's LLM spend next to the rest of your cloud bill. Finance gets the same numbers as the Costs page, split by team, agent, model, and person, without anyone copying them by hand.

There are three ways, from quickest to most automated:

- **Download a view:** a one-off CSV, JSON, or Parquet file of what the cost explorer shows.
- **Query the API:** pull the same numbers from a script or pipeline on your own schedule.
- **Schedule exports:** Archestra writes a [FOCUS](https://focus.finops.org/) file for every hour or day into your own bucket. Most of this page covers this way.

## Download a View

Open **Costs & Limits → Costs**, set up the [cost explorer](/docs/llm-proxy/costs-and-limits/costs#slice-usage-in-the-cost-explorer) view you want, then click **Export** above its table and pick **CSV**, **JSON**, or **Parquet**. The file holds the table as it is on screen, for the selected date range.

- A split **Summary** exports every metric: one line per row and split value, with requests, tokens, billed spend, and subscription estimate side by side.

## Query the API

Script the same numbers when a scheduled file does not fit, such as a nightly job that loads them into your own billing system. The footer of the cost explorer shows the exact request behind the current view, so you can copy it.

- [`GET /api/statistics/llm-usage`](/docs/reference/api/operations#tag/statistics/GET/api/statistics/llm-usage) groups requests, tokens, and spend by any mix of day, team, agent, person, credential, provider, and model.
- Send an [API key](/docs/reference/api#authentication) in the `Authorization` header. The key sees what its owner can see, so organization-wide figures need [`llmCost:read`](/docs/reference/permissions#llmCost:read).

## Schedule Exports to Object Storage

Archestra writes one CSV per hour or per day into your own Amazon S3 or Google Cloud Storage bucket, or Azure Blob Storage container. Each file is in FOCUS 1.2, the FinOps Foundation's open format for cost and usage data, which tools such as Athena, BigQuery, and DuckDB read as a table.

Before you start, add a [blob provider](/docs/admin/blob-providers) for the bucket or container. Managing exports takes the [`costExport`](/docs/reference/permissions#costExport:read) permissions. Scheduling, changing, or running one also requires [`llmCost:read`](/docs/reference/permissions#llmCost:read), so the permission never exports spend its holder could not see.

1. Open **Costs & Limits → Exports** and click **Schedule export**.
2. Name it and pick the blob provider under **Destination**.
3. Under **How often**, pick **Daily** for one file per UTC day or **Hourly** for one file per hour.
4. Under **Start from**, keep **Now**, or pick **A date** or **All recorded usage** to also write past usage.
5. Optionally change the **Folder**, `cost-exports` by default.
6. Click **Schedule**, then **Run now** to write a file right away. The row shows **Writing now…**, then **Healthy** once the file is in the bucket.

Each row shows whether the export is **Healthy**, **Waiting for first file**, **Failing**, or **Paused**. A failing row shows why the bucket refused the file: click **Fix destination** to edit the blob provider, then **Retry**. For each error and its fix, see [Fix a Failed Connection Test](/docs/admin/blob-providers#fix-a-failed-connection-test).

### Where Files Land

Each period is one file, under the blob provider's key prefix, then the export's **Folder**:

```text
<provider prefix>/cost-exports/year=2026/month=11/day=10/archestra-focus-2026-11-10.csv
<provider prefix>/cost-exports/year=2026/month=11/day=10/archestra-focus-2026-11-10T14.csv
```

The first line is a daily file and the second an hourly file for 14:00 to 15:00 UTC. The `year=`, `month=`, and `day=` folders are Hive-style partitions, so a query that filters by date reads only the matching files.

### When Files Are Written

Archestra writes a period once it has been over for 15 minutes, so requests still running at its end are counted. Expect each file about 15 to 20 minutes after its hour or day ends.

- With **Start from** set to **Now**, the first file is the period in progress when you create the export. A past start is a backfill: every period since then is written, oldest first.
- **Run now** writes every period that is due. When none is due, it rewrites the latest completed period.
- A period always goes to the same key. A rerun or retry overwrites its file, so a period is never in two files.
- After an outage or a failed write, the export writes every period since its last file.
- A failing export retries on its own, less often the longer it fails: 5 minutes after the first failure, up to once an hour.

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

- Files name each person by email. Limit who can read the bucket or container accordingly.
- To sum spend, add `BilledCost`. Adding `ListCost` counts subscription traffic at list price.
- Changing the schedule never writes an hour twice. After a switch from hourly to daily, the rest of the current day is written as hourly files, and daily files start at the next midnight UTC.
