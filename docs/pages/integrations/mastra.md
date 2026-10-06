---
title: Mastra
description: Route a Mastra agent through the LLM Proxy
order: 7
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Mastra supports a custom OpenAI-compatible model URL for agent requests.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment), an OpenAI provider key, and a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Use the virtual key as the client API key. Choose a model available through the mapped provider, such as `gpt-4o`.

The client must reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace it with your deployment's URL. A client inside a separate Docker container needs a reachable hostname, such as `host.docker.internal`, rather than `localhost`.

## Configure the Agent

Install Mastra in your TypeScript application:

```bash
pnpm add @mastra/core
```

Set `OPENAI_API_KEY` in your application's server environment to the Archestra virtual key. Configure the agent's model with the proxy URL:

```typescript
import { Agent } from "@mastra/core/agent";

const agent = new Agent({
  id: "connection-check",
  name: "Connection Check",
  instructions: "Answer the user's request.",
  model: {
    id: "openai/gpt-4o",
    url: "http://localhost:9000/v1/openai",
    apiKey: process.env.OPENAI_API_KEY,
  },
});

const result = await agent.generate("Reply with connection verified.");
console.log(result.text);
```

Use the base URL, not `/chat/completions`. The `openai/` prefix selects the provider; the upstream model name is `gpt-4o`. Custom URLs use Chat Completions by default. See [Mastra's model configuration](https://mastra.ai/models#use-local-models-with-mastra).

## Verify the Connection

Send `Reply with connection verified.` and check that the client returns a response. Open **Logs → LLM Proxy** in Archestra and find the request by its model and timestamp. Open the request to check its status and virtual key.

A `401` means the credential is missing or invalid. Check that the virtual key has an OpenAI mapping. A connection error means the client cannot reach the API URL. A model error means the selected model is unavailable through that provider.

To add remote tools, connect your application to an [MCP Gateway](/docs/mcp/gateway).
