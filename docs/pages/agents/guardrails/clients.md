---
title: Guardrail Clients
sidebarTitle: Clients
description: Make Guardrails check your client, with built-in support or session headers
order: 3
alpha: "Turn it on with [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA), then restart the backend."
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check the tool calls of any client that sends its traffic through Archestra. **Archestra Chat, Claude Code, Codex CLI, and OpenCode work as they are.** Any other client adds one header.

## Connect a Client

1. [Connect the client](/docs/get-started/connect) to the [LLM Proxy](/docs/llm-proxy) and the [MCP Gateway](/docs/mcp/gateway). The proxy checks each tool call. The gateway gives the agent the tools to handle a block.
2. For a client without built-in support, add the [session headers](#session-headers).

The **Client coverage** card on **Guardrails → Overview** lists the supported clients, and sets what happens to [unrecognized ones](#unrecognized-clients).

## Servers Connected to a Client

A battery covers an MCP server someone connected straight to their coding client, such as a Slack server in Claude Code's own config, the same way it covers that server installed from the registry. Once a request from the client has gone through the LLM Proxy, the server appears under **MCP servers** on **Guardrails → Overview** with the client's name, and its row's **Attach** offers the batteries whose rules name its tools. A hand-written rule reaches it too: bind the rule's server to the server's id, such as `claude-code.slack`, in `[server_aliases]`.

- A server is known by its client and label, so everyone in the organization who connects a server under that label is covered by the same battery.
- The configuration agent lists these servers and their fitting batteries, and proposes the attachment for approval.

## Session Headers

Give each conversation one session ID, and send it with every request. Guardrails then know which requests belong together.

- **`X-Appa-Session-ID`** (required): a new ID per conversation, such as a UUID. Keep it for every turn.
- **`X-Appa-Parent-ID`**: the parent conversation's ID. Send it only from a subagent.

For example, with the OpenAI SDK, create one client per conversation:

```python
import uuid
from openai import OpenAI

client = OpenAI(
    base_url="https://archestra.example.com/v1/openai",
    api_key="your-virtual-key",
    default_headers={"X-Appa-Session-ID": str(uuid.uuid4())},
)
```

## Unrecognized Clients

By default, Guardrails let an unrecognized client through, unchecked. To change that, open the **Client coverage** card on **Guardrails → Overview**:

- **Allowed** (default): its requests reach the model without checks.
- **Blocked:** the proxy rejects its requests with HTTP 400 and tells the user to add a session header.

![The Client coverage card on the Guardrails Overview tab](/docs/automated_screenshots/platform-ai-tool-guardrails_client_coverage.webp)

## Subagents and Teammates

Work handed to another agent stays under the same policy.

- **Subagents:** a subagent runs in its own session. The parent decides before it starts what it may return. Its answer passes a [checked return path](https://www.openappa.com/contracts#remedy-plans-and-child-returns).
- **Claude Code teammates:** a message that adds no restrictions arrives directly. Any other message waits. The receiver can read it with [`read_peer_message`](/docs/reference/archestra-mcp-server#read_peer_message), and then takes on its restrictions.
