---
title: Costs & Limits
description: Track LLM spend by team, agent, model, and person, and set usage limits
order: 3
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra records the cost of every model request from chat, agents, and the [LLM Proxy](/docs/llm-proxy). Use it to:

- See spend by person, team, agent, app, and model.
- Set spend and rate limits for model requests.
- See how much use your Claude and ChatGPT subscriptions cover.


<span id="statistics"></span>

## Track Spending

**Costs** shows the whole company's spend. **My Usage** shows each person their own.

### Company Spend

Go to **Costs & Limits → Costs** and pick a timeframe. You need [`llmCost:read`](/docs/reference/permissions#llmCost:read). The five summary boxes show metered API spend, subscription usage estimates, requests, tokens, and active people.

1. Pick a saved view, such as **Spend by model** or **Who is using it**, or choose a metric and grouping yourself.
2. Click rows to compare their trends in the chart. **Summary** sorts totals; **Pivot** compares time buckets or a secondary breakdown.
3. Use **Copy as CSV** to export the result. The API call below the table identifies the source endpoint.
4. To inspect a model, team or virtual key's limits, select one row and use the limits action beside the chart controls. Its label names the kind and selection, such as **Show token limits for example-model**. The Limits tab keeps that context selected; **Clear** removes it. Viewing limits requires [`llmLimit:read`](/docs/reference/permissions#llmLimit:read).

Token totals use recorded usage, including cache reads and writes. Requests in flight may not appear yet. The skill token view measures injected context instead of model consumption.

- Subscription estimates value usage at equivalent API rates. They exclude subscription fees and are not a bill.
- App opens and tool calls measure activity. The app spend view includes build and runtime costs, marks shared build sessions, and compares runtime usage with the chat-equivalent estimate. Opening an app does not itself imply inference.
- Skills show activations, context tokens, distinct people, and attributed turn spend. Skill spend can overlap when several skills share a turn; partial context measurements are marked. Access to app and skill breakdowns follows their resource permissions. Other people's usage also requires access to the member list.

<span id="proxy-cost-attribution"></span><span id="per-user-usage"></span><span id="per-app-cost"></span><span id="per-skill-cost"></span><span id="attributing-external-proxy-traffic"></span>

To tie proxy traffic to a person, use a credential that names one. See [Authentication](/docs/llm-proxy/authentication#attribution-in-logs).

### Group Proxy Costs by Label

Group proxy spend by labels such as `cost_center=engineering` without changing historical reports when labels change.

1. Add labels to a virtual key or OAuth client under **Advanced → Labels**, or to its billing team.
2. In **Costs & Limits → Costs**, choose **by → Label** and choose a label key.
3. Use the existing chart, **Summary**, **Pivot**, and **Copy as CSV** controls.

#### Where Labels Come From

For each label key, Archestra uses the first matching value in this order:

1. The authenticated virtual key or OAuth client.
2. Its billing team.

Labels are captured when the request starts. Later edits do not rewrite historical spend, and caller-supplied request metadata cannot override attribution labels. Requests without a value, including older requests, appear as **Unassigned (label missing)**.

In **Logs → LLM Proxy**, hover the label icon to see the captured labels for the request shown. Open a request to see its **Attribution labels**. Other requests in the same session can have different labels.

<span id="my-usage"></span>

### Your Own Usage

Click your name in the sidebar, then **My Usage**, to compare your model and client activity without access to company-wide costs.

1. Choose a saved view or use **Show** and **by** to select a metric and grouping. Click rows to compare their totals in the chart.
2. Choose **Time → Pivot** to compare time buckets. For model or client tokens, choose **split by → Token type**, then **Pivot**.
3. Use **Token mix**, **Context size**, or **Costliest sessions** to inspect those breakdowns. **Copy as CSV** exports the selected table.

- The **Tokens** summary includes reported input, output, cache reads and cache writes. **Token mix** separates those categories.
- Subscription estimates and context list-price values are not additional bills. Sessions show only the costliest returned sessions; elapsed minutes are not active working time.
- Model and client totals are independent breakdowns. A model-by-client pivot is unavailable.

<span id="usage-limits"></span>

<span id="set-a-budget"></span>

<span id="limit-spend"></span>

## Set a Limit

Cap a team's monthly requests, a key's daily tokens, or the organization's spend per minute. Every matching parent and model rule applies; raising a key's allowance does not remove its team's cap.

Creating a limit requires [`llmLimit:create`](/docs/reference/permissions#llmLimit:create).

1. Go to **Costs & Limits → Limits** and click **Add Limit**.
2. Choose who the rule applies to.
3. Pick models, or **All models**.
4. Enter **Limit value** and choose **Spend**, **Tokens**, or **Requests** under **Limit kind**.
5. Choose **Interval**, then click **Create limit**. The saved row shows its units, interval and current use.

All three units support every interval: per minute; rolling hour, 12 hours, day, week or month; calendar day, week starting Sunday or Monday, or month. Requests, tokens and per-minute spend support organization, team and virtual-key scopes. Longer-period spend also supports users, agents, LLM OAuth clients and environments.

Amounts start blank and require a positive whole number, including dollar caps. Decimals, negatives and amounts above 2,147,483,647 are rejected. Changing the limit kind clears the amount. Until you choose an interval, Spend defaults to Calendar month and Tokens or Requests default to Per minute; an explicit interval choice is kept.

Click a row's **Edit limit** button to change its amount, models or interval. Limit kind and scope stay fixed. Editing requires [`llmLimit:update`](/docs/reference/permissions#llmLimit:update).

Use **All kinds** to show only **Spend**, **Tokens**, or **Requests**. Combine it with the status, scope and model filters; **Clear** restores all rules.

![Spend and rate rules in the Limits table](/docs/automated_screenshots/llm-proxy_limits.webp)

<span id="default-user-limits"></span><span id="limit-cleanup"></span>

- **Default user spend:** set a default per-user limit under **Settings → LLM**. A per-environment default replaces it in that environment. A user's own limit replaces both.
- **Per minute:** an unused allowance permits a burst up to its limit and recovers continuously. Sixty requests per minute recovers room for one request each second. Rejected requests are not queued.
- **Longer intervals:** rolling periods reset after elapsed time; calendar periods reset at the next UTC day, week or month boundary. Changing the interval starts a fresh period. Changing only the amount keeps current use.
- **Spend:** actual billed cost, including cents, counts after completion. Requests already in flight can take spend above the cap. Subscription use counts as $0.

Environment spend adds up the agents in that environment. Agents with no environment do not count. Default user spend settings retain their own reset schedules.

![Choose units beside the amount and set an interval](/docs/automated_screenshots/llm-proxy_throughput.webp)

<span id="limit-requests-and-tokens-per-minute"></span>

## Count Requests and Tokens

Request and token allowances apply across replicas, including subscription traffic. Both aggregate and matching model rules apply. Model rules match the routed model ID used in LLM logs; Claude context suffixes such as `[1m]` do not create another model.

Requests count once per admitted logical call, including upstream errors. Internal connection retries share its admission; a new client retry is another call.

Token limits count only usage reported by the provider. Before sending a request, Archestra checks the usage already recorded; it does not forecast the incoming request's tokens. Requests already in flight can exceed the allowance, and later requests are blocked until usage recovers or resets.

Archestra does not add or change output bounds. Reported input, cache-read, cache-write, and output tokens count once, including Gemini's separately reported reasoning. Complete provider iteration breakdowns replace the primary totals; the logical call's routed-model rules apply to the whole breakdown.

- Reported usage counts once when a call finishes, including known partial usage after an interrupted stream. Missing usage is not charged; locally estimated metrics do not count. Pair token limits with request limits when you also need to bound call volume.
- Tokens count in the interval active when usage is recorded, including calls that cross a reset or interval edit. Reporting is available for 24 hours after admission; calls that outlive that accounting receipt are not charged.

## When a Request Is Blocked

The gateway identifies its own denials separately from provider throttles.

| Response | What to do |
| --- | --- |
| `402`, `token_cost_limit_exceeded` | Wait for spend to recover or reset, or raise the cap. Spend checks actual billed use before each call; it does not reserve estimated cost. |
| `429`, `archestra_quota_exceeded` | Wait at least `Retry-After` seconds. It accounts for continuous recovery or the next period across every matching cap; new traffic can extend the wait. |
| `503`, `archestra_quota_storage_unavailable` | Shared usage storage is unavailable. A preflight failure prevents the upstream call; a reporting failure can occur after the provider has processed it. Check logs before retrying. |

Provider throttles retain their existing status, body and headers.
- Native chat completions, Messages, Responses (including compact), Gemini generation, Bedrock Converse, and embeddings routes share admission. Embeddings count reported input tokens. Unhandled inference operations, including image/audio generation and batch creation, return `400` with `archestra_quota_unsupported_endpoint` while any throughput limit exists, even for another key. Metadata and status reads, file transfer, deletion, cancellation, and token counting remain available. Media tokens count only when the provider reports them. A stream already sent cannot change its HTTP status if recording usage fails; that failure appears in gateway logs.

Deleting a rule removes its restriction.

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

- Subscription use bills $0 and never counts toward a [spend limit](#limit-spend). Costs shows it as **Subscription-covered**.
- A Claude subscription that runs into paid usage credits turns metered. Archestra reads this from Anthropic's response headers.
- To count every new request as metered, set [`ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT=false`](/docs/admin/deployment/configuration#ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT). Past requests keep their classification.

<span id="model-pricing"></span><span id="prompt-caching"></span>

## Where Token Prices Come From

A cost uses the model's price. Archestra syncs input, output, and cache prices for known models. OpenRouter is the exception: Archestra records the cost OpenRouter reports for each request, so the price of the provider it routed to is what counts. A model it does not know gets an estimated price. For a custom or self-hosted model, set the price yourself. See [Model Pricing, Limits, and Modalities](/docs/llm-proxy/providers#model-pricing-limits-and-modalities).

Prompt caching lowers the cost of a prompt that starts the same way each time. Costs and logs show the cache reads and writes the provider reports. Archestra adds cache points to its own chat and agent requests. Proxy requests keep the caller's own cache markers.

## What to Know

- **Need the raw numbers?** Get them per person from [`GET /api/statistics/users`](/docs/reference/api#/Statistics/getUserStatistics), or your own from [`GET /api/statistics/me`](/docs/reference/api#/Statistics/getMyStatistics). For daily counts of tool calls, app runs, and skill activations, group [`GET /api/statistics/mcp-tool-calls`](/docs/reference/api#/Statistics/getMcpToolCallUsage), [`app-usage`](/docs/reference/api#/Statistics/getAppUsage), or [`skill-usage`](/docs/reference/api#/Statistics/getSkillUsage) by `day`.
- **Already use Prometheus or Grafana?** Archestra exports cost and token metrics, so you can chart spend next to your other dashboards. See [Metrics](/docs/admin/observability/metrics#llm-metrics).
