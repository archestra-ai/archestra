---
title: See It Work
description: Send your first message in Chat and from a connected client, then find both in the logs
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Send one request through Archestra, then find it in the logs. Every model call and tool call shows up there, from Chat and from connected clients.

<span id="check-the-connection"></span>

## In Chat

1. Open **Chat** in the Archestra sidebar.
2. Archestra needs a model provider before you can chat. Click **Sign in with ChatGPT**, another subscription, or **Add API Key**, and follow the dialog.
3. Send a message, such as "What tools can you use?".

## From Your Client

Use the client you connected in [Connect Your Agents](/docs/get-started/connect):

- **Tools:** ask your client to list the Archestra gateway's tools. If they are missing, complete the gateway sign-in shown in **Connect**, then reload the client.
- **Models:** send any prompt.
- **Skills:** ask for one of the shared skills you selected during setup.

## Find It in the Logs

Open **Logs** in the Archestra sidebar:

- **LLM Proxy** lists sessions, with their requests and spend.
- **MCP Gateway** lists each tool call, with its caller and result.

Click a row to see the full request. Your requests from Chat and from your client are both there. See [Logs and Auditing](/docs/admin/logs) for the other tabs.

**Next:** [build an agent](/docs/agents), or [add MCP servers](/docs/mcp/servers) to give your agents more tools.
