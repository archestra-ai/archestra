---
title: Logs and Auditing
description: Investigate model requests, tool calls, and admin changes
order: 7
lastUpdated: 2026-11-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Know what every agent did, as whom, and what it cost. Archestra logs every model request, tool call, and admin change, from Chat, messaging channels, and connected clients. You do not turn anything on.

![An incident investigation with model requests and parallel MCP tool calls on a shared waterfall timeline, including timing, tokens, cost, and conversation details](/docs/automated_screenshots/admin-logs_session-waterfall.webp)

## What Gets Logged

| Tab | One row per | Open a row for |
| --- | --- | --- |
| **LLM Proxy** | Session: agent, model, tokens, spend | The whole conversation. **Export JSON** saves it. |
| **MCP Gateway** | Tool call: tool, gateway, account used, result | The arguments and the full result |
| **Audit** | Change: who, what, when, and if it succeeded | The values before and after, the source IP, and any admin acting as someone else |
| **Guardrails consult** | Request to a service used by [Guardrails](/docs/agents/guardrails): service, tool, outcome | The service request and reply |
| **Agent connections** | Calls grouped by user, agent, or gateway; setup and disconnect events under **Activity** | Drill into a group to see which agents and gateways it used |

Open an **LLM Proxy** session to see every request and the MCP tool calls it triggered on one timeline; select a row for its timing, tokens, cost, conversation, and raw request and response. A tool call opened from the **MCP Gateway** tab shows where it sat in its session, or nearby calls from the same caller when it is not linked to one. Timing measures request processing before the log is saved, including the full stream for LLM requests. Older records may have no timing.

In **Agent connections**, the **Usage** tab groups calls with **Show** and **by**; select a bar or row to drill down, and **Back** to step out. The page follows the selected date range, except the **State** column on **User connections**, which always reflects the last 30 days. **User connections** lists users with no calls too, and **Export CSV** saves the filtered list.

## Reading Token Counts After a Disconnected Stream

If a client disconnects before the provider reports usage, the LLM Proxy log can retain partial response content with zero input and output tokens. Those zeros are placeholders for missing usage, not proof that the provider used no tokens. When the provider did report partial counts, the billing usage record has `status: "incomplete"` and includes `partial_stream` in `issues`.

For an operational signal that the request was cancelled, use the metadata-only [`archestra.llm_proxy.request` event](/docs/admin/observability/tracing#proxy-request-log-events): check `archestra.proxy.outcome` and `archestra.proxy.error_origin`. A streamed response can have HTTP status `200` even when it ends after the client disconnects. There is currently no separate "usage unknown" field on an LLM Proxy interaction row whose provider sent no usage.

## Keep Prompts Out of the Logs

Keep the cost and audit trail without storing what people sent. Set [`ARCHESTRA_LOGS_CONTENT_MODE=metadata_only`](/docs/admin/deployment/configuration#ARCHESTRA_LOGS_CONTENT_MODE) and restart Archestra. Each row still shows the agent, the model or tool, the account used, tokens, cost, and whether the call failed. Opening it shows **Content not stored** instead of the prompt, response, arguments, or result.

- Rows already stored keep their content.
- Traces leave the content out too, even when content capture is on.
- Chat history is not affected.

## Keep Media in the Logs

By default, logs keep the conversation text but not the images, audio, and files in it. Each row shows **Not kept: media logging is off** where media was. To let Logs show and play media, go to **Settings → LLM**, turn on **Keep media in logs**, and click **Save**.

- The setting covers model requests and responses and MCP tool calls, from Chat, agents, and connected clients.
- Changing it needs [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) and applies to new rows only.
- Traces never carry media, whatever the setting.

## Who Can Read Them

One permission shows your own logs. An admin permission shows everyone's.

| Tab | Your own | Everyone's |
| --- | --- | --- |
| LLM Proxy, MCP Gateway, Guardrail consults | [`log:read`](/docs/reference/permissions#log:read) | [`log:admin`](/docs/reference/permissions#log:admin) |
| Audit | [`auditLog:read`](/docs/reference/permissions#auditLog:read) | [`auditLog:admin`](/docs/reference/permissions#auditLog:admin) |

Sharing an agent or a gateway with someone does not let them read its logs.

## What to Know

- Logs stay forever by default. To delete old records, set a retention window. Retention is an [Enterprise feature](/docs/get-started/pricing-model). See [Data Retention](/docs/admin/deployment/configuration#data-retention).
- Behind a load balancer, set [`ARCHESTRA_TRUST_PROXY`](/docs/admin/deployment/configuration#ARCHESTRA_TRUST_PROXY). Otherwise audit records show the load balancer's IP, not the client's.
- To send data to your own tools, use [metrics](/docs/admin/observability/metrics) and [traces](/docs/admin/observability/tracing).
