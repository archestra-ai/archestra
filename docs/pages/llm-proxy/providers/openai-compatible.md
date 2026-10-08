---
title: OpenAI-compatible Servers
description: Connect vLLM, llama.cpp, LM Studio, or another OpenAI-compatible server
order: 5
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect vLLM, llama.cpp, LM Studio, SGLang, or any other server with the OpenAI `/v1` API. Add it as the **OpenAI-compatible** provider. Archestra uses its Chat Completions and Embeddings endpoints.

## Connecting a Server

Start your model server before adding it. Archestra must be able to reach its URL; `localhost` inside a container refers to that container.

1. Go to **Model Providers → Add API Key** and select **OpenAI-compatible**.
2. Set **Base URL** to the server's OpenAI API root, for example `http://model-server:8000/v1`.
3. Enter an API key if your server requires one. Otherwise leave it blank.
4. Click **Test & Create**.

The key appears in the provider table, and the models returned by your server appear under **Models**. A server that lists several models needs only one key entry. Add separate entries for servers on different URLs.

Proxy clients use `https://<archestra-host>/v1/vllm`. Through the [Model Router](/docs/llm-proxy/model-router), use model IDs prefixed with `vllm:`.

## Deployment Configuration

Set [`ARCHESTRA_VLLM_BASE_URL`](/docs/reference/configuration#ARCHESTRA_VLLM_BASE_URL) to configure a default endpoint. A Base URL set on a provider key takes precedence. [`ARCHESTRA_CHAT_VLLM_API_KEY`](/docs/reference/configuration#ARCHESTRA_CHAT_VLLM_API_KEY) supplies its default credential when needed.

The API key variable alone does not create a provider key at startup: the Base URL variable must also be set. If connection testing fails, check that the backend can reach the server and that `/models` is available under the configured API root.
