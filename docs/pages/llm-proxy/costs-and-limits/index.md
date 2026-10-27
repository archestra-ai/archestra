---
title: Costs & Limits
description: See what every model call costs and cap spend, tokens, or requests before bills climb
order: 3
lastUpdated: 2026-10-26
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Every model call through Archestra—from [Chat](/docs/chat), [Agents](/docs/agents), or an external tool using the [LLM Proxy](/docs/llm-proxy)—is metered as it finishes. Break down spend and token usage across your organization in [Costs](/docs/llm-proxy/costs-and-limits/costs), and cap spend, tokens, or requests in [Limits](/docs/llm-proxy/costs-and-limits/limits) before a runaway loop or shared key drives up your bill.

![Costs & Limits → Costs showing API spend, subscription usage estimate, requests, tokens, and the cost explorer](/docs/automated_screenshots/llm-proxy_costs.webp)

<span id="track-spending"></span><span id="statistics"></span><span id="proxy-cost-attribution"></span><span id="per-user-usage"></span><span id="per-app-cost"></span><span id="per-skill-cost"></span><span id="attributing-external-proxy-traffic"></span><span id="my-usage"></span><span id="usage-limits"></span><span id="set-a-budget"></span><span id="limit-spend"></span><span id="default-user-limits"></span><span id="limit-cleanup"></span><span id="limit-requests-and-tokens-per-minute"></span>

## Subscription vs Metered Cost

<span id="subscription-vs-metered-cost"></span>

Archestra separates per-token API charges from flat-rate subscription traffic so subscription usage never inflates your reported bill or triggers a dollar spend cap. Both [Costs](/docs/llm-proxy/costs-and-limits/costs) and [Limits](/docs/llm-proxy/costs-and-limits/limits) use this distinction:

| Credential | Counted as | Why |
| --- | --- | --- |
| Claude subscription (`sk-ant-oat01-...` or OAuth), ChatGPT Plus/Pro (Codex OAuth), GitHub Copilot, Microsoft 365 Copilot, Zhipu AI Coding Plan | **Subscription (`$0` billed)** | Covered by a flat monthly seat. Archestra records `$0` toward **API spend** and [spend limits](/docs/llm-proxy/costs-and-limits/limits), and tracks what those tokens would have cost at list API rates under **Subscription usage estimate**. |
| Provider API keys (`sk-ant-api03-...`, `sk-...`, Gemini, Bedrock, Vertex AI, Azure, Mistral, Cohere, DeepSeek, Groq, Fireworks, Together, xAI, Cerebras, OpenRouter, vLLM, Ollama) | **Metered (billed at token prices)** | Billed per token. Counts toward **API spend** and [spend limits](/docs/llm-proxy/costs-and-limits/limits). |

Both metered and subscription traffic count toward [token and request limits](/docs/llm-proxy/costs-and-limits/limits).

- **Override on a credential:** when adding or editing a key in **Credentials → LLM Provider API Keys**, set **Cost tracking** to **Metered (per-token billing)** or **Subscription (included in plan)**. Leave it on **Automatic (detect from key)** to use the table above.
- **Paid overage on a subscription:** if an Anthropic subscription exhausts its plan window and spills into paid Extra Usage (`anthropic-ratelimit-unified-overage-status: active`), Archestra counts that call as metered spend.
- **Disable automatic detection:** set [`ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT=false`](/docs/admin/deployment/configuration#ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT) so only credentials explicitly marked **Subscription** are excluded from metered spend.

## Where Token Prices Come From

<span id="model-pricing"></span><span id="prompt-caching"></span>

Archestra syncs per-million-token prices (input, output, cache read, and cache write) for common models automatically.

- **OpenRouter:** when OpenRouter returns `usage.cost` on a response, Archestra records that exact amount instead of recalculating from the price table.
- **Custom or self-hosted models:** go to **Models**, edit the model, and open its **Pricing** tab to view or set rates per million tokens (see [Model Pricing, Limits, and Modalities](/docs/llm-proxy/providers#model-pricing-limits-and-modalities)). Unlisted models default to `$1.00` per million input and output tokens until you set a price.
- **Prompt caching:** cached input tokens are priced at the model's cache read and cache write rates.

## Recompute Past Costs After a Price Change

A new price applies to new requests at once. To correct requests already recorded at a wrong or `$0` price, recompute them when you save the price, and [Costs](/docs/llm-proxy/costs-and-limits/costs) and [Limits](/docs/llm-proxy/costs-and-limits/limits) show what they should have cost.

1. Go to **Models**, edit the model, and open **Pricing**.
2. Set the new prices.
3. Under **Apply new prices to**, pick **Requests since a date** or **All recorded requests**. For a date, drag the start on the cost chart, pick a preset, or pick an exact date and time. Days recorded at `$0` are flagged under the chart.
4. Check the strip above the options: how many requests change, their cost before and after, and how many users are affected. Then click **Save Changes**.

The recompute runs in the background. Reopen **Pricing** to see its progress and, when it finishes, how many requests changed. It needs [`llmModel:update`](/docs/reference/permissions#llmModel:update) on the model.

- **OpenRouter:** past requests keep their recorded cost, because many of them carry the amount OpenRouter actually charged.
- **LiteLLM:** when your LiteLLM gateway prices a model per API key, set a custom input and output price first (and cache prices, if its requests used the cache). Every recomputed request uses those prices.
- **Already settled:** requests settled under [`ARCHESTRA_LLM_PROXY_USAGE_ACCOUNTING_MODE=enforce`](/docs/admin/deployment/configuration#ARCHESTRA_LLM_PROXY_USAGE_ACCOUNTING_MODE) keep the cost they were charged. Subscription requests are recomputed but stay `$0` billed.
