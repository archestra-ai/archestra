---
title: See It Work
description: Send your first message in Chat and from a connected client, then find both in the logs
order: 3
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Send one request through Archestra, then find it in the logs. Every model call and tool call shows up there, from Chat and from connected clients.

## Verify from the Terminal

Before opening your browser or client, you can verify that the Archestra services are running:

```bash
curl -s http://localhost:9000/health
```

A response containing `"status":"ok"` confirms the backend API and gateway are active.

## In Chat

1. Open **Chat** in the Archestra sidebar.
2. Connect a model provider: click **Sign in with ChatGPT**, another subscription, or **Add API Key** (such as Anthropic, OpenAI, or Gemini) and follow the dialog.
3. Click the **What can Archestra do?** suggestion. The assistant searches the current Archestra docs and answers with links to the pages. **How does OpenAPPA protect agents?** does the same with the OpenAPPA docs. With an enterprise license, send a message such as *"What tools can you use?"* instead.

What to know:

- A fresh install without an enterprise license comes with two MCP servers for the suggestions: **Archestra Docs** (`https://archestra.ai/mcp`) and **OpenAPPA Docs** (`https://www.openappa.com/mcp`). Both read public docs and need no credentials.
- To remove one, delete it from the **MCP Registry**. It does not come back after a restart or an upgrade.

## From Your Client

Use the client you connected in [Connect Your Agents](/docs/get-started/connect):

- **Tools:** ask your client to list the Archestra gateway's tools. If they are missing, complete the gateway authentication shown in **Connect**, then reload the client.
- **Models:** send any prompt.
- **Skills:** ask for one of the shared skills you selected during setup.

## Find It in the Logs

Open **Logs** in the Archestra sidebar:

- **LLM Proxy** lists sessions, with their requests and spend.
- **MCP Gateway** lists each tool call, with its caller and result.

Click a row to see the full request. Your requests from Chat and from your client are both there. See [Logs and Auditing](/docs/admin/logs) for the other tabs.

**Next:** [build an agent](/docs/agents), [add MCP servers](/docs/mcp/servers) to give your agents more tools, or [migrate your agents](/docs/get-started/migrate).
