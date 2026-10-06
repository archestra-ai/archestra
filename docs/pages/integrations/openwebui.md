---
title: Open WebUI
description: Connect Open WebUI models and tools to Archestra
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Open WebUI connects to Archestra through its OpenAI-compatible connection and remote MCP tool server settings.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment). To route model requests through it, configure an OpenAI provider key in Archestra and use a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider as the client API key. Choose a model available through the mapped provider, such as `gpt-4o`. Connecting tools alone requires a gateway token instead; see [Connect Tools](#connect-tools).

The client must reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace it with your deployment's URL. A client inside a separate Docker container needs a reachable hostname, such as `host.docker.internal`, rather than `localhost`.

## Connect the Model

1. Open **Settings → Admin → Connections** in Open WebUI.
2. Add a connection under **OpenAI API**.
3. Set the URL to `http://localhost:9000/v1/openai` and the API key to your Archestra virtual key.
4. Verify the connection and save it. Select a model from that connection in a new chat.

These controls are described in [Open WebUI's OpenAI-compatible connection guide](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/).

## Connect Tools

Create an [MCP Gateway](/docs/mcp/gateway) in Archestra and assign its tools. Copy the connection URL and a gateway token.

In Open WebUI, go to **Settings → Admin → Integrations**. Under **External Tool Servers**, add a connection of type **MCP (Streamable HTTP)**. Set the URL to `https://api.example.com/v1/mcp/<gateway-id>` and configure bearer authentication with the gateway token. Save, then enable the tool server in your chat. See [Open WebUI's MCP setup](https://docs.openwebui.com/features/extensibility/mcp).

Ask for a read-only action supported by an assigned tool. Confirm the tool appears in the chat and its call appears in Archestra's **Logs → MCP Gateway**.

## Verify the Connection

Send `Reply with connection verified.` and check that the client returns a response. Open **Logs → LLM Proxy** in Archestra and find the request by its model and timestamp. Open the request to check its status and virtual key.

A `401` means the credential is missing or invalid. Check that the virtual key has an OpenAI mapping. A connection error means the client cannot reach the API URL. A model error means the selected model is unavailable through that provider.

For workflows with tools, keep both assistant tool calls and tool results in the conversation sent to the proxy. Configure [guardrails](/docs/agents/guardrails) for those tools; routing model requests alone does not give an agent access to the MCP Gateway.
