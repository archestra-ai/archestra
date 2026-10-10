---
title: Web UIs and Automation
description: Connect n8n workflows and Open WebUI to Archestra LLM Proxy and MCP Gateway
order: 4
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

You can connect visual chat interfaces and workflow automation platforms to Archestra. Routing model requests through the LLM Proxy provides unified logs, spending limits, and guardrails, while the MCP Gateway supplies tools to your workflows.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment).

- **For model routing:** Configure an OpenAI provider key in Archestra and create a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Choose a model available under that provider, such as `gpt-4o`.
- **For tool access:** Create an [MCP Gateway](/docs/mcp/gateway) and generate a gateway token.

The client application must be able to reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace this with your deployment's base URL. Applications running inside Docker containers should use a reachable network host such as `host.docker.internal` rather than `localhost`.

## n8n

<span id="n8n"></span>

n8n AI workflows can route model inference through the LLM Proxy and execute tools via the MCP Gateway.

### Connect the Model

1. Open your workflow and attach an **AI Agent** node to your trigger.
2. Connect an **OpenAI Chat Model** node to the agent's model input.
3. Configure the OpenAI credential: set **Base URL** to `http://localhost:9000/v1/openai` and **API Key** to your Archestra virtual key.
4. Select a model supported by your provider and save the workflow.

Store virtual keys in n8n's credential manager rather than inline workflow expressions.

### Connect Tools

<span id="connect-tools"></span>

1. In Archestra, create an [MCP Gateway](/docs/mcp/gateway), assign the required tools, and copy the connection URL and gateway token.
2. In n8n, add an **MCP Client Tool** node to your agent's tools input.
3. Set the endpoint URL to `https://api.example.com/v1/mcp/<gateway-id>`.
4. Choose **Bearer Auth** and supply your Archestra gateway token.
5. Select the tools to expose to the agent.

Archestra supports both legacy SSE and modern Streamable HTTP transports.

## Open WebUI

<span id="openwebui"></span>
<span id="open-webui"></span>

Open WebUI connects to Archestra via its OpenAI-compatible model provider and remote MCP tool server settings.

### Connect the Model

1. Navigate to **Settings → Admin → Connections** in Open WebUI.
2. Add a new connection under **OpenAI API**.
3. Set the API URL to `http://localhost:9000/v1/openai` and enter your Archestra virtual key as the API key.
4. Verify the connection, save it, and select your model in a new conversation.

### Connect Tools

1. Navigate to **Settings → Admin → Integrations**.
2. Under **External Tool Servers**, add a connection of type **MCP (Streamable HTTP)**.
3. Set the URL to `https://api.example.com/v1/mcp/<gateway-id>` and configure Bearer authentication with your gateway token.
4. Save and enable the tool server for your chat sessions.

## Verify the Connection

<span id="verify-the-connection"></span>

Send `Reply with connection verified.` to confirm inference. In Archestra, open **Logs → LLM Proxy** and verify that the request appears with the expected model and virtual key.

- A `401` status indicates a missing or invalid virtual key.
- A connection error indicates that the client cannot reach the Archestra API URL.
- A model error indicates that the requested model is not available under the mapped provider.

To test tools, prompt the client to run a read-only action supported by an assigned tool. Check **Logs → MCP Gateway** in Archestra to confirm tool execution. Configure [guardrails](/docs/agents/guardrails) on your gateway to enforce invocation policies.
