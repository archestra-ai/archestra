---
title: LLM Proxy Logs
description: List saved model requests and inspect their usage, cost, and routing decisions
order: 1
lastUpdated: 2026-11-04
---

Find the saved record for a model request and see its usage, cost, and routing decision.

## Read one request

[`GET /api/llm-proxy-logs/{logId}`](/docs/reference/api/llm-proxy/logs#tag/llm-proxy-logs/GET/api/llm-proxy-logs/{logId}) returns the request recorded by Archestra; it does not change the provider response sent to your client.

```bash
curl -H "Authorization: arch_..." \
  https://archestra.example.com/api/llm-proxy-logs/<log-id>
```

The response includes request and response payloads, attribution, cost, and usage. These usage fields are an excerpt from a log response:

```json
{
  "inputTokens": 12,
  "inputTokensEstimated": false,
  "outputTokens": null,
  "cacheReadTokens": 0,
  "cacheWriteTokens": null
}
```

## Interpret usage fields

These fields distinguish a known zero from a missing count.

| Field | Meaning |
| --- | --- |
| `inputTokens`, `outputTokens` | Recorded input and output tokens. `null` means unavailable; `0` is a recorded zero. |
| `inputTokensEstimated` | Whether Archestra estimated the input count locally instead of using a provider count. |
| `cacheReadTokens`, `cacheWriteTokens` | Tokens read from or written to the provider cache. `null` means unavailable or not applicable; `0` is a recorded zero. |
| `cacheWrite1hTokens` | Tokens written to a one-hour provider cache, when the provider reports them. |

A numeric count can still be partial if a stream ends early. The endpoint's response schema below contains the complete field list.
