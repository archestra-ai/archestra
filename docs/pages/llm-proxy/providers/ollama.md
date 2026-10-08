---
title: Ollama
description: Connect an Ollama server and choose its native or OpenAI-compatible transport
order: 6
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run models on your own server with Ollama, and use them like any cloud model, with no API key. Pull a model with `ollama pull <model-name>` before you connect it.

## Connecting Ollama

1. Go to **Model Providers → Add API Key** and select **Ollama**.
2. Choose **Native** or **OpenAI-compatible** transport.
3. Set **Base URL** to your server. Native uses the server root, such as `http://model-server:11434`; OpenAI-compatible uses `http://model-server:11434/v1`.
4. Leave **API Key** blank for a local server, or enter the credential required by your deployment.
5. Click **Test & Create**.

The server's pulled models appear under **Models**. Add one key entry per server. If Archestra runs in Docker and Ollama runs on the host, use `host.docker.internal` instead of `localhost` where your container runtime supports it.

| Transport | Proxy URL | Use |
| --- | --- | --- |
| Native | `https://<archestra-host>/v1/ollama-native` | Ollama `/api/chat` and generation parameters |
| OpenAI-compatible | `https://<archestra-host>/v1/ollama` | Chat Completions, Embeddings, and Model Router |

Native model IDs cannot be used through the Model Router. For that endpoint, connect the OpenAI-compatible transport and use `ollama:<model-id>`.

## Generation Parameters

Under **Models**, edit a native model and set **Model parameters**, including `num_ctx`, `num_predict`, temperature, and thinking. Empty fields inherit Ollama's defaults. The OpenAI-compatible transport does not carry these Ollama-specific options.

If you cap the server's context with `OLLAMA_CONTEXT_LENGTH`, also set `num_ctx` on the model. The server does not report that global cap to Archestra. Models marked **Limited for complex tasks** may be less reliable for agents that call tools.

Default endpoints come from [`ARCHESTRA_OLLAMA_BASE_URL`](/docs/reference/configuration#ARCHESTRA_OLLAMA_BASE_URL) and [`ARCHESTRA_OLLAMA_NATIVE_BASE_URL`](/docs/reference/configuration#ARCHESTRA_OLLAMA_NATIVE_BASE_URL). Use a per-key Base URL to override them.
