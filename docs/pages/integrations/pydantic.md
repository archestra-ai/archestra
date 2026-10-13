---
title: Pydantic AI
description: Route Pydantic AI model requests through Archestra
order: 6
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Pydantic AI uses an OpenAI provider with a custom base URL to connect to Archestra.

## Requirements

You need a running [Archestra deployment](/docs/admin/deployment), an OpenAI provider key, and a standard [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) mapped to that provider. Use the virtual key as the client API key. Choose a model available through the mapped provider, such as `gpt-4o`.

The client must reach Archestra's API. The examples use `http://localhost:9000/v1/openai`; replace it with your deployment's URL. A client inside a separate Docker container needs a reachable hostname, such as `host.docker.internal`, rather than `localhost`.

## Configure the Provider

Install Pydantic AI in your Python environment:

```bash
pip install pydantic-ai
```

Set `OPENAI_API_KEY` in your application's environment to the virtual key. Keep the key in your server environment.

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

`OpenAIChatModel` selects Chat Completions explicitly. For Responses, use `OpenAIResponsesModel` with the same provider. See [Pydantic AI's OpenAI provider documentation](https://ai.pydantic.dev/models/openai/).

## Verify the Connection

Send `Reply with connection verified.` and check that the client returns a response. Open **Logs → LLM Proxy** in Archestra and find the request by its model and timestamp. Open the request to check its status and virtual key.

A `401` means the credential is missing or invalid. Check that the virtual key has an OpenAI mapping. A connection error means the client cannot reach the API URL. A model error means the selected model is unavailable through that provider.

To add remote tools, connect your application to an [MCP Gateway](/docs/mcp/gateway).
