---
title: n8n
description: Connect an n8n AI workflow to Archestra
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

n8n AI workflows can send model requests through the LLM Proxy and use MCP Gateway tools.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment). To route model requests through it, configure an OpenAI provider key in Archestra and use a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider as the client API key. Choose a model available through the mapped provider, such as `gpt-4o`. Connecting tools alone requires a gateway token instead; see [Connect Tools](#connect-tools).

The client must reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace it with your deployment's URL. A client inside a separate Docker container needs a reachable hostname, such as `host.docker.internal`, rather than `localhost`.

## Connect the Model

1. Open your workflow and connect a **Chat Trigger** to an **AI Agent**.
2. Add an **OpenAI Chat Model** to the agent's model input.
3. Create or edit the model's OpenAI credential. Set **API Key** to your Archestra virtual key and **Base URL** to `http://localhost:9000/v1/openai`.
4. Select a model served by your provider and save the workflow.

Keep the Archestra virtual key in n8n's credential store, rather than in workflow expressions. The provider key stays in Archestra. See [n8n's OpenAI credentials](https://docs.n8n.io/integrations/builtin/credentials/openai).

## Connect Tools

Create an [MCP Gateway](/docs/mcp/gateway) in Archestra and assign the tools the workflow needs. Copy its connection URL and a gateway token.

Add an **MCP Client Tool** to the agent's tools input. Enter the gateway URL (`https://api.example.com/v1/mcp/<gateway-id>`). Select **Bearer Auth** and supply the gateway token. Choose the tools to expose to the agent. If your n8n version labels the URL **SSE Endpoint**, use the same gateway URL; Archestra supports legacy SSE as well as Streamable HTTP. See [n8n's MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp).

## Verify the Connection

Send `Reply with connection verified.` and check that the client returns a response. Open **Logs → LLM Proxy** in Archestra and find the request by its model and timestamp. Open the request to check its status and virtual key.

A `401` means the credential is missing or invalid. Check that the virtual key has an OpenAI mapping. A connection error means the client cannot reach the API URL. A model error means the selected model is unavailable through that provider.

For workflows with tools, keep both assistant tool calls and tool results in the conversation sent to the proxy. Configure [guardrails](/docs/agents/guardrails) for those tools; routing model requests alone does not give an agent access to the MCP Gateway.
