---
title: Azure AI Foundry
description: Connect Azure model deployments with an API key or Microsoft Entra ID
order: 2
lastUpdated: 2026-10-22
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use the models you deployed in Azure, with an API key or with no key at all through Microsoft Entra ID. Each deployment name becomes a model ID, so `gpt-5-prod` in Azure is `gpt-5-prod` in your requests.

## Add Azure

1. Go to **Model Providers → Add API Key** and select **Azure AI Foundry**.
2. Set **Base URL** to your resource, not to one deployment:

   | Your resource | Base URL |
   | --- | --- |
   | Azure OpenAI | `https://<resource-name>.openai.azure.com/openai` |
   | A Foundry project with its own OpenAI endpoint | `https://<project-name>.openai.azure.com/openai` |
   | Microsoft Foundry v1 | `https://<resource-name>.services.ai.azure.com/openai/v1` |

3. Paste the resource's API key from the [Azure Portal](https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI). Leave it empty if you [use Entra ID](#keyless-authentication-with-microsoft-entra-id).
4. Click **Test & Create**.

Your deployments show under **Models**. Clients call `https://<archestra-host>/v1/azure` with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys). The Azure resource key stays in the provider configuration; it does not authenticate clients to Archestra.

One provider key covers the whole resource. Do not add a key for each deployment.

## Use the Azure SDK

Point `AzureOpenAI` at Archestra and replace the Azure key with your virtual key; Archestra selects the configured Azure credential.

```python
import os
from openai import AzureOpenAI

client = AzureOpenAI(
    azure_endpoint="https://archestra.example/v1/azure",
    api_key=os.environ["ARCHESTRA_VIRTUAL_KEY"],
    api_version="2025-01-01-preview",
)
response = client.chat.completions.create(
    model="my-gpt-deployment",
    messages=[{"role": "user", "content": "Reply READY."}],
)
```

```javascript
import { AzureOpenAI } from "openai";

const client = new AzureOpenAI({
  endpoint: "https://archestra.example/v1/azure",
  apiKey: process.env.ARCHESTRA_VIRTUAL_KEY,
  apiVersion: "2025-01-01-preview",
});
const response = await client.chat.completions.create({
  model: "my-gpt-deployment",
  messages: [{ role: "user", content: "Reply READY." }],
});
```

For the standard `OpenAI` client, use `https://archestra.example/v1/azure/openai/v1` as the base URL and the same virtual key. Existing clients using `/v1/azure` and bearer authentication also work.

- The deployment in the SDK's URL selects the model and its limits, even when the request body names a different model.
- Archestra preserves your API version and query parameters. The configured API version supplies the default for classic requests without one.
- Send one credential: conflicting `api-key` and `Authorization` values are rejected. Unsupported Azure APIs return an error.

## Choose a Model API

Select an image or audio deployment in Chat to receive a generated file, or call its matching proxy endpoint from your client.

| Model type | Proxy path after `/v1/azure` | Chat behavior |
| --- | --- | --- |
| Text and code | `/responses` or `/chat/completions`, as supported by the deployment | Streaming conversation and agent tools |
| Images (`gpt-image-*`) | `/images/generations` | Describe an image; the completed image appears in the conversation |
| Audio (`gpt-audio*`) | `/chat/completions` with `modalities: ["text", "audio"]` and `audio` settings | Type speech or attach WAV/MP3; receive a transcript and playable WAV |
| Realtime (`gpt-realtime-*`) | `/realtime/turns` | Type speech or attach WAV; receive a completed audio turn |
| Realtime translation (`gpt-realtime-translate*`) | `/realtime/turns` with `target_language` | Attach WAV and enter a language code such as `es` |
| Embeddings (`text-embedding-*`) | `/embeddings` | Vector output only; excluded from conversational model selection |

Use your deployment alias in `model`, such as `production-images`. Archestra identifies media support from Azure's deployment metadata for the selected provider key. Refresh provider models after changing a deployment or its connection settings; Chat requires current metadata to select a media API.

If Azure does not expose deployment metadata, explicit proxy endpoints let Azure validate the request. Changing a model's display modalities does not establish its supported APIs.

### Generate an Image

Image generation returns base64 image data through the proxy and a visible image in Chat.

```bash
curl "https://<archestra-host>/v1/azure/images/generations" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"A blue circle on white","n":1,"size":"1024x1024","quality":"low"}'
```

Use `/images/edits` for reference images and masks. Image generation and editing return completed responses; `stream: true` and `partial_images` return validation errors.

### Edit an Image

Call the Images API with the Archestra URL and virtual key. The proxy selects the permitted Azure provider credential, validates the uploads, and records file metadata and hashes without storing uploaded image bytes in interaction requests.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="https://<archestra-host>/v1/azure",
    api_key=os.environ["ARCHESTRA_VIRTUAL_KEY"],
)
with open("reference.png", "rb") as image, open("mask.png", "rb") as mask:
    result = client.images.edit(
        model="gpt-image-1",
        prompt="Replace the blue square with a green circle.",
        image=[image],
        mask=mask,
        n=1,
    )
```

Send between 1 and 16 PNG, JPEG, or WebP references, each smaller than 50 MiB and at most 16,777,216 pixels. An optional PNG mask must be smaller than 4 MiB, match the first image's dimensions, and contain an alpha channel with fully transparent pixels. The configured [proxy body limit](/docs/admin/deployment/configuration#ARCHESTRA_API_BODY_LIMIT) also bounds the complete multipart request. Invalid MIME declarations, duplicate scalar parameters, malformed uploads, URL references, and unsupported fields are rejected before inference.

The selected deployment and API version must support image editing, input formats, and the parameters you request. Known DALL-E 2 deployments accept one square PNG reference smaller than 4 MiB. Returned token usage is recorded when available. Image edit cost remains unknown because media pricing is unavailable; enforced accounting and applicable financial budgets block the request before Azure is called.

### Use Provider Files

The Azure `/openai/v1` resource endpoint supports bounded SDK file lifecycle requests through `/v1/azure/files`: create, retrieve, list, content, and delete. Each request requires a platform credential and one permitted configured Azure account. If more than one account is permitted, select one with the `provider-api-key-id` header. Deployment-specific Files URLs, anonymous requests, subscription credentials, and ambiguous account selection are rejected. Files require a stored or authenticated passthrough API key; keyless Entra accounts and raw provider JWT passthrough are rejected until a stable upstream identity can be verified and bound.

```python
with open("input.txt", "rb") as source:
    uploaded = client.files.create(file=source, purpose="user_data")
try:
    metadata = client.files.wait_for_processing(uploaded.id)
    content = client.files.content(uploaded.id).read()
finally:
    client.files.delete(uploaded.id)
```

Only `purpose="user_data"` is accepted. Upload one nonempty file within the configured proxy body limit. Wait for processing before downloading; unavailable content returns 409. Optional `expires_after` must use `anchor="created_at"` and between 3,600 and 2,592,000 seconds. Azure remains responsible for provider expiry and storage; an expired handle is unavailable through Archestra.

Archestra returns an opaque file handle bound to the organization, authenticated principal, and selected provider account. Listing returns metadata for that principal's uploads, rather than the account's complete file inventory. Account endpoint, credential, or account header changes invalidate existing bindings. Deleting a handle requires Azure to confirm deletion. Upload registration failures trigger a best-effort remote deletion; a lost upstream response can leave a remote upload whose ID Archestra never received.

These handles support file lifecycle operations only. Referencing them in inference, resumable Uploads API requests, and other file purposes are explicitly unsupported. Send image references as multipart image files. Provider Files and Chat attachments have separate storage and authorization. File storage cost is unknown, so enforced accounting and applicable financial budgets block uploads. Azure may reject operations unsupported by the selected resource; the proxy returns that error.

Image parameters are validated against the discovered backing model. The proxy preserves `response_format` for compatible legacy models; GPT Image rejects it because its response is always base64. Unknown fields return a validation error instead of being discarded.

### Send an Audio Turn

Use `/realtime/turns` for a bounded speech request with Archestra's authentication, limits, and request logs.

```json
{
  "model": "gpt-realtime-2.1",
  "messages": [{"role": "user", "content": "Say hello."}],
  "max_completion_tokens": 256
}
```

The response follows the Chat Completions shape: `choices[0].message.content` contains the transcript and `choices[0].message.audio.data` contains base64 WAV. `stream: true` emits the completed audio turn over SSE; it does not provide a live duplex session.

Realtime turns require a Foundry v1 URL. For translation, send `target_language`, such as `es`, with a user `input_audio` part containing base64 WAV. Uploaded WAV is converted to 24 kHz mono PCM and is limited to 60 seconds per file; a turn times out after 90 seconds.

- Realtime turns do not execute agent tools. Full-duplex WebSocket and WebRTC clients cannot connect through this HTTP endpoint.
- Chat shows completed image and audio files after generation finishes. Media model requests do not run the assistant's tools.
- Translation does not return token usage. Its audio cost cannot be measured from the response.

<span id="keyless-authentication-with-microsoft-entra-id"></span>

## Sign In Without a Key

Let Archestra sign in to Azure as itself, so no Azure key is stored anywhere. It uses Azure's `DefaultAzureCredential`: a workload identity, a managed identity, a service principal, or your local Azure CLI sign-in.

1. Set [`ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED).
2. Give that identity a role on the Azure resource: **Cognitive Services OpenAI User** for Azure OpenAI, or **Cognitive Services User** for Foundry Models.
3. Add Azure as above, with the API key empty.

To try the flow on your laptop first, see the [keyless example](https://github.com/archestra-ai/examples/tree/main/azure-openai-keyless).

### On AKS

Use [Microsoft Entra Workload ID](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview) with a user-assigned managed identity. Turn on the OIDC issuer and workload identity, and create a federated credential for Archestra's service account:

```bash
az aks update \
  --resource-group "$AKS_RESOURCE_GROUP" \
  --name "$AKS_CLUSTER_NAME" \
  --enable-oidc-issuer \
  --enable-workload-identity

export AKS_OIDC_ISSUER="$(az aks show \
  --resource-group "$AKS_RESOURCE_GROUP" \
  --name "$AKS_CLUSTER_NAME" \
  --query oidcIssuerProfile.issuerUrl \
  --output tsv)"

az identity federated-credential create \
  --resource-group "$IDENTITY_RESOURCE_GROUP" \
  --identity-name "$USER_ASSIGNED_IDENTITY_NAME" \
  --name archestra-platform \
  --issuer "$AKS_OIDC_ISSUER" \
  --subject "system:serviceaccount:$NAMESPACE:$SERVICE_ACCOUNT_NAME" \
  --audience api://AzureADTokenExchange
```

Then annotate the Helm service account and add the pod label required by the AKS workload identity webhook:

```yaml
archestra:
  orchestrator:
    kubernetes:
      serviceAccount:
        name: archestra-platform
        annotations:
          azure.workload.identity/client-id: "<user-assigned-managed-identity-client-id>"
  podLabels:
    azure.workload.identity/use: "true"
  env:
    ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED: "true"
```

The subject must match your Helm release's namespace and service account. See Microsoft's [AKS Workload ID guide](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster).

## When It Does Not Work

| You see | Do this |
| --- | --- |
| No models after **Test & Create** | Check that **Base URL** is the resource, not a deployment URL. With Entra ID, give the identity **Cognitive Services OpenAI User** on the backing Azure AI Services resource, at its full resource scope. |
| A model you see in Azure is missing | Check that it has a deployment on the configured resource. Archestra lists deployments, not the model catalog. |
| Deployments appear, but inference returns 401 or 403 | Discovery access does not grant inference access. Check the identity's inference role on the configured resource, or use its existing API key. |
| An image or realtime model rejects a text endpoint | Use the matching endpoint above, or select the model in Chat. |
| A Claude model fails | Claude on Foundry uses Anthropic's API. Add it as the [Anthropic provider](/docs/llm-proxy/providers/anthropic#anthropic-on-microsoft-foundry). |
| `'max_tokens' is not supported with this model` | Use a Foundry v1 URL, or set [`ARCHESTRA_AZURE_OPENAI_API_VERSION`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_API_VERSION) to `2024-09-01` or later. Archestra then sends `max_completion_tokens` to OpenAI model deployments. |
| An Azure API version error | Set the SDK's API version, or configure [`ARCHESTRA_AZURE_OPENAI_API_VERSION`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_API_VERSION) as the classic default and [`ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION) as the `/responses` default. Foundry v1 URLs need no version. |

## What to Know

- **Deployment discovery access:** a custom role can use `Microsoft.Resources/subscriptions/read`, `Microsoft.Resources/subscriptions/resources/read`, `Microsoft.CognitiveServices/accounts/read`, and `Microsoft.CognitiveServices/accounts/deployments/read`. Inference needs the additional Azure inference role described above.
- **Discovery and requests on different endpoints:** set `inferenceBaseUrl` on the provider key through the API. Archestra lists deployments from **Base URL** and sends every request to the inference URL.
- **Grok on Azure** works through a Foundry v1 URL, once the model is deployed.
