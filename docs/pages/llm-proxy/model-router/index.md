---
title: Model Router
description: Call models from multiple providers through an OpenAI-compatible endpoint
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

One OpenAI-compatible URL for every provider. Switch from GPT to Claude by changing the model name, not your code. Any app built on the OpenAI SDK can reach Anthropic, Gemini, Bedrock, or your own vLLM server. Every request still gets Guardrails, costs, and logs.

<span id="connecting-a-client"></span>

## Connect an App

1. Add the provider keys you need on [Model Providers](/docs/llm-proxy/providers).
2. Create a [standard virtual key](/docs/llm-proxy/authentication#standard-virtual-keys), and map those provider keys to it.
3. Set your app's base URL to `https://<archestra-host>/v1/model-router`, and use the virtual key as its API key.
4. List the models the key can reach:

   ```bash
   curl "https://<archestra-host>/v1/model-router/models" \
     -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY"
   ```

5. Send a request with one of those IDs:

   ```bash
   curl "https://<archestra-host>/v1/model-router/chat/completions" \
     -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"openai:gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
   ```

The answer comes back in OpenAI format, whatever the provider.

## Name a Model

Put the provider in front of the model ID: `openai:gpt-5.4`, `anthropic:claude-sonnet-4-6`. The router sends the request to that provider, with the model ID after the first colon. A key mapped to only one provider can also use plain IDs, such as `gpt-5.4`.

<span id="apis-and-authentication"></span>

## APIs and Sign-In

| Endpoint | Notes |
| --- | --- |
| `/chat/completions` | All router providers |
| `/responses` | All router providers |
| `/models` | Only the models your credential can reach |
| `/embeddings` | Not Anthropic, Bedrock, Cohere, or GitHub Copilot |

The router takes a standard virtual key or an [OAuth client](/docs/llm-proxy/authentication#oauth-clients) token. It does not take a passthrough key, a provider's own key, or an identity provider JWT.

<span id="request-limits"></span>

## When a Request Fails

| You see | Do this |
| --- | --- |
| The model is not found, or the key is not mapped to its provider | Check the ID against `/models`. Map a key for that provider to your credential. |
| "Model … is only served over the Responses API" | Send the request to `/responses`. For GitHub Copilot, `supported_endpoints` in `/models` shows each model's API. |
| An empty or cut-off Gemini answer | Raise `max_completion_tokens`. For Gemini, it includes thinking tokens. |
| An image or file seems ignored | The provider does not take that content. Send it inline as base64, to a provider that does. |
| A provider is not in `/models` at all | The router cannot reach it. See [supported providers](/docs/llm-proxy/providers#supported-providers). |

## What to Know

- GitHub Copilot needs a person. Use your personal virtual key or user OAuth. A Copilot subscription cannot serve an app.
- The provider still sets the limits. The router keeps the OpenAI request shape, but reasoning settings and content types are the provider's.
