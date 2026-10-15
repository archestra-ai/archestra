---
title: AI SDKs and Frameworks
description: Route Vercel AI SDK, Pydantic AI, and Mastra requests through the LLM Proxy
order: 5
lastUpdated: 2026-10-15
---

Keep your SDK's model calls and route them through Archestra for usage logs, spending limits, and Guardrails. The examples below use OpenAI Chat Completions.

## Requirements

Configure an OpenAI provider key and a [standard virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to it.

Set `OPENAI_API_KEY` in your application's server environment to the virtual key. Replace `http://localhost:9000/v1/openai` with your reachable Archestra endpoint. A container's `localhost` refers to that container; use its host-network address, such as Docker Desktop's `host.docker.internal`, when Archestra runs on the host.

## Session IDs for Guardrails

Use one stable [session ID](/docs/agents/guardrails/clients#session-headers) per conversation, including retries and follow-up turns.

Each example creates a client for a conversation already loaded by your application. Replace `conversation.id` with your stored conversation or thread ID. If you generate a UUID, save it once and reload it for subsequent turns.

| Header | Value |
| --- | --- |
| `X-Appa-Session-ID` | This conversation's ID. |
| `X-Appa-Parent-ID` | The parent's session ID, only for a delegated child. Give the child its own session ID. |

Keep clients carrying session headers scoped to that conversation. A process-wide client with a fixed ID mixes unrelated conversations' policy state.

## Vercel AI SDK

<span id="vercel-ai"></span>
<span id="vercel-ai-sdk"></span>

Install `ai` and `@ai-sdk/openai`, then configure [the OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai) with your proxy URL.

```typescript
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

// Load this conversation from your application before creating the client.
const openai = createOpenAI({
  baseURL: "http://localhost:9000/v1/openai",
  apiKey: process.env.OPENAI_API_KEY,
  headers: { "X-Appa-Session-ID": conversation.id },
});

const result = await generateText({
  model: openai.chat("gpt-4o"),
  prompt: "Reply with connection verified.",
});
console.log(result.text);
```

Use `.chat()` to select Chat Completions explicitly. Keep the key and client in server-side code.

<span id="configure-guardrails"></span>

## Pydantic AI

<span id="pydantic"></span>
<span id="pydantic-ai"></span>

Install `pydantic-ai`, then pass a custom client to [`OpenAIProvider`](https://ai.pydantic.dev/models/openai/#custom-openai-client).

```python
import os
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

client = AsyncOpenAI(
    base_url="http://localhost:9000/v1/openai",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={"X-Appa-Session-ID": conversation.id},
)
model = OpenAIChatModel("gpt-4o", provider=OpenAIProvider(openai_client=client))
agent = Agent(model)
result = agent.run_sync("Reply with connection verified.")
print(result.output)
```

`OpenAIChatModel` selects Chat Completions. Use `OpenAIResponsesModel` with the same provider for Responses.

<span id="configure-guardrails-1"></span>

## Mastra

<span id="mastra"></span>

Install `@mastra/core` and configure the agent's [custom model endpoint](https://mastra.ai/models#use-local-models-with-mastra).

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
    headers: { "X-Appa-Session-ID": conversation.id },
  },
});

const result = await agent.generate("Reply with connection verified.");
console.log(result.text);
```

Use the base URL, without `/chat/completions`. The `openai/` prefix identifies the provider.

<span id="configure-guardrails-2"></span>

## Verify the Connection

Find the test request in **Logs → LLM Proxy** with the expected model, virtual key, and timestamp.

| Symptom | Check |
| --- | --- |
| `401` | The application sends the virtual key and the key has an active provider mapping. |
| Connection refused or timeout | The application's network can reach the configured host and API port. |
| Model error | The mapped provider supports the requested model. |
| Unrecognized client or missing policy state | Every call carries the intended conversation's session header. Check [Guardrail Clients](/docs/agents/guardrails/clients). |

For tool access, connect your SDK's MCP client to an [MCP Gateway](/docs/mcp/gateway) as well.
