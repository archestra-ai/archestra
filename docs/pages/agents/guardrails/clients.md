---
title: Guardrail Clients
sidebarTitle: Clients
description: Make Guardrails check your client, with built-in support or session headers
order: 3
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check the tool calls of any client that sends its traffic through Archestra. Built-in clients work out of the box. Any other client adds one header.

## Supported Clients

These clients identify themselves to the proxy and work without extra configuration:

- **Archestra Chat**: built-in chat in the platform. Tracks conversations automatically.
- **Claude Code**: terminal coding agent. Passes session identifiers through request headers.
- **Codex CLI**: terminal coding agent. Sends conversation identifiers in request metadata.
- **OpenCode**: terminal coding agent. Sends its session headers automatically.
- **Kilo Code**: terminal coding agent built on OpenCode. Sends the same session headers automatically.

All other clients, including workflow automations like [n8n](/docs/integrations/web-ui-and-automation#n8n) and custom API integrations, require [session headers](#session-headers).

## Connect a Client

Route model requests through the proxy so Guardrails can check the tool calls the model asks for.

1. [Connect the client](/docs/get-started/connect) to the [LLM Proxy](/docs/llm-proxy) and the [MCP Gateway](/docs/mcp/gateway). The proxy checks each tool call. The gateway gives the agent the tools to handle a block.
2. For a client without built-in support, add the [session headers](#session-headers).

**Other clients** under **Settings → Guardrails** sets what happens to [unrecognized ones](#unrecognized-clients).

## Approval Cards

Read the complete call and policy scope before approving. Long text arguments can have a **Generated summary** to help you find the purpose and constraints. The summary can omit details; it never replaces the exact arguments or grants permission.

Archestra prepares the summary with a separate model request, without tools or your conversation history. This uses inference tokens and requires an [explicitly configured summary model](/docs/reference/configuration#ARCHESTRA_OPENAPPA_REVIEW_SUMMARY_PROVIDER); it does not use the organization's default model automatically. If no summary model is configured or summarization fails, the complete review still appears.

Claude Code keeps short approvals on one card. Larger requests start with an overview showing the tool, target, policy scope, and a generated summary when available. Choose **Approve**, **Deny**, or **Inspect details**; opening the details is optional.

**Inspect details** prints the complete platform review in the chat transcript, then shows the same approval card again. Prose keeps its paragraphs, commands use literal code blocks, and structured values use formatted JSON. There are no detail-page questions, and inspection never grants permission.

Inspecting adds the full review to the conversation history and therefore to subsequent model requests. It does not rewrite earlier messages or change the tool arguments. Stale or mismatched answers cannot authorize a changed call; if the complete policy scope cannot fit safely in the overview, that card does not offer **Approve**.

Use the chat transcript's selection and copy controls for the full review. Claude Code controls selection inside its native preview pane; Archestra cannot enable it through the question tool.

## Session Headers

Send the same session ID with every model call in a conversation or workflow run. Guardrails use it to remember policy decisions and restrictions across turns, tool calls, and retries.

- **`X-Appa-Session-ID`**: your app's conversation ID or workflow execution ID. If you do not have one, generate a UUID when the conversation starts and save it.
- **`X-Appa-Parent-ID`**: optional parent session ID when running a subagent or child workflow. Keep both IDs stable for every call the child makes.

For client examples, see [n8n](/docs/integrations/web-ui-and-automation#configure-guardrails) and the [SDK examples](/docs/integrations/sdks-and-frameworks#session-ids-for-guardrails).

With `curl`, generate an ID once and reuse it across requests:

```bash
export SESSION_ID="$(uuidgen)"

curl "https://archestra.example.com/v1/openai/chat/completions" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "X-Appa-Session-ID: $SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

Reuse `$SESSION_ID` when sending tool results back to the model.

### What to Know

- Reuse the same ID when resuming a chat. Start a new ID only when a separate conversation starts.
- Any string up to 512 bytes works (no control characters). It does not need to be a UUID.
- [`X-Archestra-Session-Id`](/docs/llm-proxy#custom-headers) labels requests in logs, but Guardrails ignore it. When you send both `X-Archestra-Session-Id` and `X-Appa-Session-ID`, use the same value for both.

## Unrecognized Clients

By default, Guardrails let an unrecognized client through, unchecked. To change that, go to **Settings → Guardrails** and set **Other clients**:

- **Allowed** (default): its requests reach the model without checks.
- **Blocked:** the proxy rejects its requests with HTTP 400 and tells the user to add an `X-Appa-Session-ID` header.

The setting also decides whether a client that Guardrails do not check can [hand work off](/docs/agents/runtime/handoff#hand-off-with-guardrails-on) to Agent Runtime.

## Subagents and Teammates

Work handed to another agent stays under the same policy.

- **Subagents:** a subagent runs in its own session. The parent decides before it starts what it may return. Its answer passes a [checked return path](https://www.openappa.com/contracts#remedy-plans-and-child-returns).
- **Claude Code teammates:** a message that adds no restrictions arrives directly. Any other message waits. The receiver can read it with [`read_peer_message`](/docs/reference/archestra-mcp-server#read_peer_message), and then takes on its restrictions.
