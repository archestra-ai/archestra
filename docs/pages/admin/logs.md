---
title: Logs and Auditing
description: See every model request, tool call, and admin change, and choose who can read them and how long they stay
order: 5
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Know what every agent did, as whom, and what it cost. Archestra logs every model request, tool call, and admin change, from Chat, messaging channels, and connected clients. You do not turn anything on.

Open **Logs** in the sidebar to answer questions such as:

- Which agent deleted that Jira ticket, and whose account did it use?
- Why did the bill jump on Tuesday?
- Who gave this team admin rights, and what did the role look like before?
- Why did Guardrails block that call?

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

## Keep Prompts Out of the Logs

Keep the cost and audit trail without storing what people sent. Set [`ARCHESTRA_LOGS_CONTENT_MODE=metadata_only`](/docs/reference/configuration#ARCHESTRA_LOGS_CONTENT_MODE) and restart Archestra. Each row still shows the agent, the model or tool, the account used, tokens, cost, and whether the call failed. Opening it shows **Content not stored** instead of the prompt, response, arguments, or result.

- Rows already stored keep their content.
- Traces leave the content out too, even when content capture is on.
- Chat history is not affected.

## Who Can Read Them

One permission shows your own logs. An admin permission shows everyone's.

| Tab | Your own | Everyone's |
| --- | --- | --- |
| LLM Proxy, MCP Gateway, Guardrail consults | [`log:read`](/docs/reference/permissions#log:read) | [`log:admin`](/docs/reference/permissions#log:admin) |
| Audit | [`auditLog:read`](/docs/reference/permissions#auditLog:read) | [`auditLog:admin`](/docs/reference/permissions#auditLog:admin) |

Sharing an agent or a gateway with someone does not let them read its logs.

## What to Know

- Logs stay forever by default. To delete old records, set a retention window. Retention is an [Enterprise feature](/docs/get-started/pricing-model). See [Data Retention](/docs/reference/configuration#data-retention).
- Behind a load balancer, set [`ARCHESTRA_TRUST_PROXY`](/docs/reference/configuration#ARCHESTRA_TRUST_PROXY). Otherwise audit records show the load balancer's IP, not the client's.
- To send data to your own tools, use [metrics](/docs/admin/observability/metrics) and [traces](/docs/admin/observability/tracing).
