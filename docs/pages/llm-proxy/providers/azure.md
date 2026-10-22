---
title: Azure AI Foundry
description: Connect Azure model deployments with an API key or Microsoft Entra ID
order: 2
lastUpdated: 2026-10-21
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

Use the deployment's model name, such as `gpt-image-1`, for image and audio routing. Arbitrary deployment aliases are supported for text, but do not identify a media model's type.

### Generate an Image

Image generation returns base64 image data through the proxy and a visible image in Chat.

```bash
curl "https://<archestra-host>/v1/azure/images/generations" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-1","prompt":"A blue circle on white","n":1,"size":"1024x1024","quality":"low"}'
```

Image editing, image inputs, and partial-image streaming are unavailable on this endpoint. `stream: true` returns a validation error.

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
| An Azure API version error | Set [`ARCHESTRA_AZURE_OPENAI_API_VERSION`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_API_VERSION), or [`ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`](/docs/admin/deployment/configuration#ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION) for `/responses`. Foundry v1 URLs use neither. |

## What to Know

- **Deployment discovery access:** a custom role can use `Microsoft.Resources/subscriptions/read`, `Microsoft.Resources/subscriptions/resources/read`, `Microsoft.CognitiveServices/accounts/read`, and `Microsoft.CognitiveServices/accounts/deployments/read`. Inference needs the additional Azure inference role described above.
- **Discovery and requests on different endpoints:** set `inferenceBaseUrl` on the provider key through the API. Archestra lists deployments from **Base URL** and sends every request to the inference URL.
- **Grok on Azure** works through a Foundry v1 URL, once the model is deployed.
