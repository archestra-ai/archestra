---
title: Logs and Auditing
description: See every model request, tool call, and admin change, and choose who can read them and how long they stay
order: 5
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Know what every agent did, as whom, and what it cost. Archestra logs every model request, tool call, and admin change, from Chat, messaging channels, and connected clients. You do not turn anything on.

Open **Logs** in the sidebar to answer questions such as:

- Which agent deleted that Jira ticket, and whose account did it use?
- Why did the bill jump on Tuesday?
- Who gave this team admin rights, and what did the role look like before?
- Why did Guardrails block that call?

<span id="what-each-tab-shows"></span>

## What Gets Logged

| Tab | One row per | Open a row for |
| --- | --- | --- |
| **LLM Proxy** | Session: agent, model, tokens, spend | The whole conversation. **Export JSON** saves it. |
| **MCP Gateway** | Tool call: tool, gateway, account used, result | The arguments and the full result |
| **Audit** | Change: who, what, when, and if it succeeded | The values before and after, the source IP, and any admin acting as someone else |
| **Guardrail consults** | [Guardrails](/docs/agents/guardrails) decision: tool, outcome | Why the call was allowed or blocked |

<span id="who-can-read-them"></span>

## Who Can Read Them

One permission shows your own logs. An admin permission shows everyone's. The audit log has no "own" view.

| Tab | Your own | Everyone's |
| --- | --- | --- |
| LLM Proxy, MCP Gateway | [`log:read`](/docs/reference/permissions#log:read) | [`log:admin`](/docs/reference/permissions#log:admin) |
| Guardrail consults | [`openappaDiagnostics:read`](/docs/reference/permissions#openappaDiagnostics:read) | [`openappaDiagnostics:admin`](/docs/reference/permissions#openappaDiagnostics:admin) |
| Audit | | [`auditLog:read`](/docs/reference/permissions#auditLog:read) |

Sharing an agent or a gateway with someone does not let them read its logs.

## What to Know

- Logs stay forever by default. To delete old records, set a retention window. Retention is an [Enterprise feature](/docs/get-started#licensing). See [Data Retention](/docs/reference/configuration#data-retention).
- Behind a load balancer, set [`ARCHESTRA_TRUST_PROXY`](/docs/reference/configuration#ARCHESTRA_TRUST_PROXY). Otherwise audit records show the load balancer's IP, not the client's.
- To send data to your own tools, use [metrics](/docs/admin/observability/metrics) and [traces](/docs/admin/observability/tracing).
