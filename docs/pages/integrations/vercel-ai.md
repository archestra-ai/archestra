---
title: Vercel AI SDK
description: Route AI SDK model requests through Archestra
order: 5
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The AI SDK OpenAI provider accepts a custom API URL and credential.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment), an OpenAI provider key, and a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Use the virtual key as the client API key. Choose a model available through the mapped provider, such as `gpt-4o`.

The client must reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace it with your deployment's URL. A client inside a separate Docker container needs a reachable hostname, such as `host.docker.internal`, rather than `localhost`.

## Configure the Provider

Install the packages in your application:

```bash
pnpm add ai @ai-sdk/openai
```

Set `OPENAI_API_KEY` in your application's environment to the virtual key. Keep the key in your server environment.

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

The explicit `.chat()` selects Chat Completions. Archestra also supports the OpenAI Responses API. See the [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai) for model factory options. Keep this code on your server so the credential is not included in browser bundles.

## Verify the Connection

Send `Reply with connection verified.` and check that the client returns a response. Open **Logs → LLM Proxy** in Archestra and find the request by its model and timestamp. Open the request to check its status and virtual key.

A `401` means the credential is missing or invalid. Check that the virtual key has an OpenAI mapping. A connection error means the client cannot reach the API URL. A model error means the selected model is unavailable through that provider.

To add remote tools, connect your application to an [MCP Gateway](/docs/mcp/gateway).
