---
title: Guardrail Clients
sidebarTitle: Clients
description: Make Guardrails check your client, with built-in support or session headers
order: 3
alpha: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-12
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check the tool calls of any client that sends its traffic through Archestra. Built-in clients work out of the box. Any other client adds one header.

## Supported Clients

These clients identify themselves to the proxy and work without extra configuration:

- **Archestra Chat**: built-in chat in the platform. Tracks conversations automatically.
- **Claude Code**: terminal coding agent. Passes session identifiers through request headers.
- **Codex CLI**: terminal coding agent. Sends conversation identifiers in request metadata.
- **OpenCode**: terminal coding agent. Sends its session headers automatically.

All other clients, including workflow automations like [n8n](/docs/integrations/web-ui-and-automation#n8n) and custom API integrations, require [session headers](#session-headers).

## Connect a Client

1. [Connect the client](/docs/get-started/connect) to the [LLM Proxy](/docs/llm-proxy) and the [MCP Gateway](/docs/mcp/gateway). The proxy checks each tool call. The gateway gives the agent the tools to handle a block.
2. For a client without built-in support, add the [session headers](#session-headers).

The **Client coverage** card on **Guardrails → Overview** lists the supported clients, and sets what happens to [unrecognized ones](#unrecognized-clients).

## Session Headers

Give each conversation one session ID, and send it with every request. Guardrails then know which requests belong together.

- **`X-Appa-Session-ID`** (required): a new ID per conversation, such as a UUID. Keep it for every turn.
- **`X-Appa-Parent-ID`**: the parent conversation's ID. Send it only from a subagent.

In [n8n](/docs/integrations/web-ui-and-automation#n8n), configure the header depending on your node:

- **OpenAI Chat Model node**: open the model's OpenAI credential, turn on **Add Custom Header**, set **Header Name** to `X-Appa-Session-ID`, and enter a session identifier.
- **HTTP Request node**: add `X-Appa-Session-ID` to the headers alongside `Authorization: Bearer <virtual-key>`. Use `{{ $execution.id }}` or a generated UUID for each execution.

With the OpenAI Python SDK, create one client per conversation:

```python
import uuid
from openai import OpenAI

client = OpenAI(
    base_url="https://archestra.example.com/v1/openai",
    api_key="your-virtual-key",
    default_headers={"X-Appa-Session-ID": str(uuid.uuid4())},
)
```

With the OpenAI Node.js SDK:

```typescript
import { randomUUID } from "node:crypto";
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://archestra.example.com/v1/openai",
  apiKey: "your-virtual-key",
  defaultHeaders: { "X-Appa-Session-ID": randomUUID() },
});
```

With `curl`:

```bash
curl "https://archestra.example.com/v1/openai/chat/completions" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "X-Appa-Session-ID: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

## Unrecognized Clients

By default, Guardrails let an unrecognized client through, unchecked. To change that, open the **Client coverage** card on **Guardrails → Overview**:

- **Allowed** (default): its requests reach the model without checks.
- **Blocked:** the proxy rejects its requests with HTTP 400 and tells the user to add an `X-Appa-Session-ID` header.

![The Client coverage card on the Guardrails Overview tab](/docs/automated_screenshots/platform-ai-tool-guardrails_client_coverage.webp)

The setting also decides whether a client that Guardrails do not check can [hand work off](/docs/agents/runtime/handoff#hand-off-with-guardrails-on) to Agent Runtime.

## Subagents and Teammates

Work handed to another agent stays under the same policy.

- **Subagents:** a subagent runs in its own session. The parent decides before it starts what it may return. Its answer passes a [checked return path](https://www.openappa.com/contracts#remedy-plans-and-child-returns).
- **Claude Code teammates:** a message that adds no restrictions arrives directly. Any other message waits. The receiver can read it with [`read_peer_message`](/docs/reference/archestra-mcp-server#read_peer_message), and then takes on its restrictions.
