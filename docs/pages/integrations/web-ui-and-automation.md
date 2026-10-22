---
title: Web UIs and Automation
description: Connect n8n workflows and Open WebUI to Archestra LLM Proxy and MCP Gateway
order: 4
lastUpdated: 2026-10-21
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run an n8n workflow or an Open WebUI chat with Archestra models and tools. Configure model routing and tool access separately, then test each connection.

## Requirements

Use the credential matching the connection you are configuring.

- **For model routing:** Configure an OpenAI provider key in Archestra and create a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Choose a model available under that provider, such as `gpt-4o`.
- **For tool access:** Create an [MCP Gateway](/docs/mcp/gateway) and generate a gateway token.

The client application must be able to reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace this with your deployment's base URL. Applications running inside Docker containers should use a reachable network host such as `host.docker.internal` rather than `localhost`.

## n8n

<span id="n8n"></span>

n8n AI workflows can route model inference through the LLM Proxy and execute tools via the MCP Gateway.

### Connect the Model

Use an OpenAI credential to keep the virtual key out of workflow expressions.

1. Open your workflow and attach an **AI Agent** node to your trigger.
2. Connect an **OpenAI Chat Model** node to the agent's model input.
3. Configure the OpenAI credential: set **Base URL** to `http://localhost:9000/v1/openai` and **API Key** to your Archestra virtual key.
4. Select a model supported by your provider and save the workflow.
5. If Guardrails are active, add the [session header](#configure-guardrails).

### Configure Guardrails

<span id="configure-guardrails"></span>
<span id="n8n-guardrails"></span>

Use n8n's [execution ID](https://docs.n8n.io/code/cookbook/builtin/execution/#executionid) as the Guardrails session ID so every run keeps its own history. n8n supplies `$execution.id` when a workflow runs; it stays the same across all model calls in that run.

1. Open the OpenAI credential used by your **OpenAI Chat Model** node.
2. Turn on **Add Custom Header**.
3. Set **Header Name** to `X-Appa-Session-ID`.
4. Switch **Header Value** to **Expression** and enter `{{ $execution.id }}`. Save the credential.

If you call the proxy with an **HTTP Request** node instead, turn on **Send Headers** and add `X-Appa-Session-ID` with `{{ $execution.id }}`. Keep the virtual key in the credential.

For a child workflow, pass the parent workflow's `$execution.id` in its input data as `parentExecutionId`. In the child's **HTTP Request** node, send both headers: `X-Appa-Session-ID` set to `{{ $execution.id }}` and `X-Appa-Parent-ID` set to `{{ $json.parentExecutionId }}`. Use an HTTP Request node when the OpenAI credential cannot supply both headers.

Run the workflow twice and check **Logs → LLM Proxy** in Archestra. Calls within each run share a session ID, and the two runs get different IDs. Never hardcode a static session ID in the credential. For chats that span multiple workflow runs, see [Session Headers](/docs/agents/guardrails/clients#session-headers).

### Connect Tools

Attach a gateway to give the agent the tools assigned in Archestra.

<span id="connect-tools"></span>

1. In Archestra, create an [MCP Gateway](/docs/mcp/gateway), assign the required tools, and copy the connection URL and gateway token.
2. In n8n, add an **MCP Client Tool** node to your agent's tools input.
3. Set the endpoint URL to `https://api.example.com/v1/mcp/<gateway-id>`.
4. Choose **Bearer Auth** and supply your Archestra gateway token.
5. Select the tools to expose to the agent.

Choose Streamable HTTP when offered. Archestra also accepts legacy SSE on the same gateway URL.

## Open WebUI

<span id="openwebui"></span>
<span id="open-webui"></span>

Open WebUI connects to Archestra via its OpenAI-compatible model provider and remote MCP tool server settings.

### Connect the Model

Add Archestra as an OpenAI-compatible connection in Open WebUI.

1. Navigate to **Settings → Admin → Connections** in Open WebUI.
2. Add a new connection under **OpenAI API**.
3. Set the API URL to `http://localhost:9000/v1/openai` and enter your Archestra virtual key as the API key.
4. Verify the connection, save it, and select your model in a new conversation.

### Configure Guardrails

<span id="openwebui-guardrails"></span>

Do not add `X-Appa-Session-ID` to Open WebUI's global connection headers. Because connection headers apply to every request, setting one there gives all chats the same session ID and mixes their guardrail policies together.

To use Guardrails with Open WebUI, route requests through a custom integration that forwards Open WebUI's chat ID in `X-Appa-Session-ID`. Without that header, Open WebUI follows your [unrecognized client setting](/docs/agents/guardrails/clients#unrecognized-clients): allowed without checks by default, or blocked if set to **Blocked**.

### Connect Tools

Add the gateway as a remote MCP tool server.

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

To test tools, prompt the client to run a read-only action supported by an assigned tool. Check **Logs → MCP Gateway** in Archestra to confirm tool execution. [Guardrails](/docs/agents/guardrails) check tool calls only when model requests go through the LLM Proxy; a gateway-only connection does not apply those checks.
