---
title: AI SDKs and Frameworks
description: Route Vercel AI SDK, Pydantic AI, and Mastra model requests through Archestra
order: 5
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

You can route requests from any OpenAI-compatible AI SDK or framework through Archestra's LLM Proxy. Requests gain central authentication, audit logging, cost tracking, and security guardrails.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment), an OpenAI provider key configured in Archestra, and a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Use the virtual key as the client API key.

The client application must be able to reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace this with your deployment's base URL. Applications running inside Docker containers should use a reachable network host such as `host.docker.internal` rather than `localhost`.

## Vercel AI SDK

<span id="vercel-ai"></span>
<span id="vercel-ai-sdk"></span>

The Vercel AI SDK OpenAI provider accepts a custom base URL and API key.

Install the required packages in your application:

```bash
pnpm add ai @ai-sdk/openai
```

Configure the provider with your Archestra base URL and virtual key:

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

const openai = createOpenAI({
  baseURL: "http://localhost:9000/v1/openai",
  apiKey: process.env.OPENAI_API_KEY,
});

const result = await generateText({
  model: openai.chat("gpt-4o"),
  prompt: "Reply with connection verified.",
});
console.log(result.text);
```

The explicit `.chat()` selects Chat Completions. Keep this code in your server environment so virtual keys are not leaked into client-side browser bundles.

## Pydantic AI

<span id="pydantic"></span>
<span id="pydantic-ai"></span>

Pydantic AI connects to Archestra using its built-in `OpenAIProvider` with a custom base URL.

Install Pydantic AI in your Python environment:

```bash
pip install pydantic-ai
```

Configure the model with your Archestra endpoint and virtual key:

```python
import os
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

model = OpenAIChatModel(
    "gpt-4o",
    provider=OpenAIProvider(
        base_url="http://localhost:9000/v1/openai",
        api_key=os.environ["OPENAI_API_KEY"],
    ),
)
agent = Agent(model)
result = agent.run_sync("Reply with connection verified.")
print(result.output)
```

`OpenAIChatModel` selects Chat Completions. For Responses, use `OpenAIResponsesModel` with the same provider.

## Mastra

<span id="mastra"></span>

Mastra supports custom OpenAI-compatible endpoints for agent execution.

Install Mastra in your TypeScript project:

```bash
pnpm add @mastra/core
```

Configure your agent's model with the Archestra base URL:

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

Use the base URL rather than `/chat/completions`. The `openai/` prefix selects the provider, followed by the upstream model name.

## Verify the Connection

<span id="verify-the-connection"></span>

Send `Reply with connection verified.` from your application and verify the response. Open **Logs → LLM Proxy** in Archestra to confirm the request appears with the expected model, virtual key, and timestamp.

- A `401` status indicates a missing or invalid virtual key. Ensure the virtual key has an active provider mapping.
- A connection error means the client cannot reach Archestra's API endpoint.
- A model error indicates the requested model is unavailable under the mapped provider.

To grant your SDK agents access to remote tools, connect them to an [MCP Gateway](/docs/mcp/gateway).
