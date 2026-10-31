---
title: Model Router
description: Call models from multiple providers through an OpenAI-compatible endpoint
order: 4
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use one OpenAI-compatible URL for every provider. Any app built on the OpenAI SDK can reach Anthropic, Gemini, Bedrock, or your own vLLM server. To change the model, change the model name. The app code stays the same. Every request still gets Guardrails, costs, and logs.

## Connect an App

Give your app a virtual key and the router URL. Then name each model with its provider in front of it.

1. Add the provider keys you need on [Model Providers](/docs/llm-proxy/providers).
2. Create a [standard virtual key](/docs/llm-proxy/authentication#standard-virtual-keys), and map those provider keys to it.
3. Set your app's base URL to `https://<archestra-host>/v1/model-router`, and use the virtual key as its API key.

   ![The new virtual key dialog, with the key and the Model Router base URL to copy](/docs/automated_screenshots/llm-proxy_model-router-key.webp)

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

The answer comes back in OpenAI format, from any provider.

- **Model IDs** start with the provider: `openai:gpt-5.4`, `anthropic:claude-sonnet-4-6`. The router sends the rest of the ID to that provider.
- **One provider only?** When the key maps to one provider, plain IDs such as `gpt-5.4` also work.

## Endpoints and Credentials

The router speaks the OpenAI API. It supports these endpoints:

| Endpoint | Works with |
| --- | --- |
| `/chat/completions` | All router providers |
| `/responses` | All router providers except Kimi (Moonshot AI) and Kimi Code, whose thinking models need their reasoning sent back on tool-call turns, which the Responses translation does not carry |
| `/models` | Lists only the models your credential can reach |
| `/embeddings` | All router providers except Anthropic, Bedrock, Cohere, and GitHub Copilot |
| `/images/generations` | OpenAI, Azure, and Gemini image models |
| `/images/edits` | OpenAI, Azure, and Gemini image models |
| `/audio/speech` | OpenAI and Azure speech models |
| `/audio/transcriptions` and `/audio/translations` | OpenAI and Azure models that support the requested operation |
| `/realtime` (WebSocket) | OpenAI realtime models |

Sign in with a [standard virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) or an [OAuth client](/docs/llm-proxy/authentication#oauth-clients) token. The router does not accept a [passthrough key](/docs/llm-proxy/authentication#passthrough-virtual-keys), a [provider's own key](/docs/llm-proxy/authentication#direct-provider-api-key), or an [identity provider JWT](/docs/llm-proxy/authentication#jwks-external-identity-provider).

## Images and Audio

Use the same OpenAI SDK client, base URL, and virtual key for text, images, and audio. The mapped provider key must have access to the requested model.

```python
from openai import OpenAI

client = OpenAI(base_url="https://<archestra-host>/v1/model-router", api_key="<virtual-key>")
image = client.images.generate(model="azure:<image-deployment>", prompt="Draw a blue circle.")
with open("speech.wav", "rb") as audio:
    transcript = client.audio.transcriptions.create(model="openai:<transcription-model>", file=audio)
```

Image responses carry the provider's image data, and transcriptions carry a `text` field. Speech responses are the audio bytes, and streamed transcriptions are SSE events, as the provider sends them. Add `/<proxy-id>` after `/v1/model-router` to select a specific LLM proxy.

Audio chat models such as `openai:gpt-audio` answer `/chat/completions` in text, or in speech when the request sets `modalities` and `audio`. Their audio tokens are priced at OpenAI's audio rates.

- **Provider parameters:** OpenAI and Azure accept their native image parameters. Gemini returns one base64 image at its own size and rejects `quality`, `size`, `output_format`, and a mask on edits. Image streaming is rejected for every provider.
- **Uploads and logs:** audio uploads are limited to 25 MiB per file. Logs keep the text spoken and the transcript. With [**Keep media in logs**](/docs/admin/logs#keep-media-in-the-logs) on, they also keep each audio clip and each image an edit uploads, up to 2 MB, so the conversation view can play or show it. A larger file is marked as not kept.
- **Pricing:** image, speech, transcription, and translation calls are priced at the vendor's published media rates: per image token, per speech character, per minute of audio. A translation or a text-format transcript reports no usage, so Archestra reads its length from the uploaded file. A WebM upload has no readable length and records no cost. **Models** lists each media model's rates.
- **Budgets:** a priced media call counts toward cost budgets like a chat call. A cost budget rejects a call that cannot be priced, such as a translation of a WebM file, before it reaches the provider.

Azure file operations stay on the Azure provider route: a router model name cannot select a file account, and a file id cannot replace a multipart image upload.

## Realtime

Open a live voice session with the SDK's realtime client and the same base URL and virtual key. Archestra checks the key and its budgets, then forwards the session to OpenAI with the mapped provider key.

```python
with client.realtime.connect(model="openai:gpt-realtime") as session:
    session.session.update(session={"output_modalities": ["audio"]})
    session.conversation.item.create(item={"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say hello."}]})
    session.response.create()
    for event in session:
        if event.type == "response.done":
            break
```

Each response of the session is one row under **Logs → LLM Proxy**, with its transcripts and its tokens and cost at OpenAI's realtime rates. With **Keep media in logs** on, the row also plays the spoken reply. SIP calls (`call_id`) are not served.

- **Budgets:** Archestra checks the budgets again before each response, including one that starts when the user stops speaking. Once a response spends them, Archestra sends an `error` event with code `budget_exceeded` and closes the session. A budget created while a session is open is checked after each response, not before it.
- **Refused sessions:** Archestra refuses a realtime session while Guardrails are enforced or a throughput limit applies to the caller. Neither can review a live session yet.

## Fix a Failed Request

Most failures come from the model name or from which provider keys your credential can use. The router names the problem in the error message. Find it below:

| Error message | Cause and fix |
| --- | --- |
| `Model "gpt-5.4" is not available. Use a provider-qualified model id…` | The ID has no provider, or your credential cannot use that model. Copy the exact ID from `/models`, such as `openai:gpt-5.4`. |
| `Model "anthropic:…" is scoped to provider "anthropic", but the Model Router virtual key is not mapped to that provider.` | Edit the virtual key, and map a key for that provider to it. |
| `Virtual API key has no provider API keys configured.` | Map at least one provider key to the virtual key. |
| `Model … is only served over the Responses API.` | Send the request to `/responses`, not `/chat/completions`. |
| `Provider "…" is not yet available through the OpenAI-compatible model router.` | The router does not support that provider. Use the provider's own [proxy endpoint](/docs/llm-proxy#start-using-it). |
| `Model router requests require a mapped virtual API key or LLM OAuth client access token.` | You sent a passthrough key, a provider key, or an identity provider JWT. Use a standard virtual key or an OAuth client token. |
| `… is per-user: it can only be used through the same user's own personal credential.` | A subscription key, such as GitHub Copilot, works only for the person who added it. Use your personal virtual key. |

Two problems return no error:

- **A Gemini answer is empty or cut off.** For Gemini, `max_completion_tokens` also counts thinking tokens. Increase it.
- **The model ignores an image or a file.** The provider does not accept that content type. Send it inline as base64, to a provider that accepts it.

## What to Know

- **Reach a new provider:** add its key on Model Providers, and map that key to your virtual key.
- **One request shape, the provider's rules:** reasoning settings, content types, and token limits still come from the provider.
