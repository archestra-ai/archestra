---
title: Supported LLM Providers
category: LLM Proxy
order: 2
description: LLM providers supported by Archestra Platform
lastUpdated: 2026-02-22
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

## Overview

Archestra Platform acts as a security proxy between your AI applications and LLM providers. It currently supports the following LLM providers.

## OpenAI-Compatible Model Router

The model router exposes one OpenAI-compatible interface for models across configured providers.

### Supported Model Router APIs

- **Responses API** (`/responses`) - ✅ Supported for text requests across model-router-compatible providers
- **Chat Completions API** (`/chat/completions`) - ✅ Supported for text chat requests across model-router-compatible providers
- **Models API** (`/models`) - ✅ Returns provider-qualified model IDs

### Model Router Connection Details

- **Base URL**: `http://localhost:9000/v1/model-router/{llm-proxy-id}`
- **Authentication**: Pass either a mapped virtual API key or an LLM OAuth client access token in the `Authorization` header as `Bearer <key>`. Use virtual keys for generic LLM clients and OAuth client access tokens for backend services that can perform OAuth client credentials. See [Authentication](/docs/platform-llm-proxy-authentication).

### List Models

Call `GET /v1/model-router/{llm-proxy-id}/models` to list OpenAI-compatible model objects. Model IDs are returned as `<provider>:<model-id>` and only include providers mapped to the virtual key or LLM OAuth client used for the request. See [Authentication](/docs/platform-llm-proxy-authentication) for configuration details.

### Model Resolution

Use provider-qualified model IDs from `/models` for deterministic routing, for example `openai:gpt-5.4`, `anthropic:claude-opus-4-6-20250918`, `groq:llama-3.1-8b-instant`, or `bedrock:amazon.nova-pro-v1:0`.

The prefix before `:` is the provider. The value after `:` is the provider's native model ID, so provider model IDs can still contain slashes or colons.

The `/models` response includes model-router-compatible text models for the providers mapped on the virtual key. Providers that use native request formats, including Anthropic, Bedrock, Gemini, and Cohere, are translated between OpenAI request/response formats and provider-native formats before forwarding.

Model Router translation is text-first. Anthropic, Gemini, and Cohere routes currently drop non-text content parts such as OpenAI `image_url` message parts; Bedrock supports base64 data URL images.

## OpenAI

### Supported OpenAI APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported
- **Responses API** (`/responses`) - ✅ Fully supported

### OpenAI Connection Details

- **Base URL**: `http://localhost:9000/v1/openai/{profile-id}`
- **Authentication**: Pass your OpenAI API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- **Use Responses API for new clients**: OpenAI recommends `/responses` for new integrations. Chat Completions remains supported for existing clients.
- **Streaming**: OpenAI streaming responses require your cloud provider's load balancer to support long-lived connections. See [Cloud Provider Configuration](/docs/platform-deployment#cloud-provider-configuration-streaming-timeout-settings) for more details.

## Anthropic

### Supported Anthropic APIs

- **Messages API** (`/messages`) - ✅ Fully supported

### Anthropic Connection Details

- **Base URL**: `http://localhost:9000/v1/anthropic/{profile-id}`
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header
- **Messages path**: `POST /v1/anthropic/{profile-id}/v1/messages`

### Anthropic on Microsoft Foundry

Claude models deployed in Microsoft Foundry use the Anthropic Messages API at `https://<resource>.services.ai.azure.com/anthropic`. Set `ARCHESTRA_ANTHROPIC_BASE_URL` to that `/anthropic` base URL. For keyless Microsoft Entra ID authentication, also set `ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED=true`; Archestra sends a bearer token scoped to `https://ai.azure.com/.default`.

Claude Foundry deployments must exist in Azure before requests will work. Use the deployed Claude model name in the Anthropic `model` field. Microsoft lists extra Claude prerequisites: a paid eligible Azure subscription, a supported region such as East US2 or Sweden Central, Azure Marketplace access for partner models, permission to subscribe to model offerings, and Contributor or Owner role on the resource group.

Azure requires Anthropic deployment metadata when creating Claude deployments: `industry`, `organizationName`, and `countryCode`. In Azure CLI this may require an ARM REST deployment call with `properties.modelProviderData`.

See Microsoft's [Claude on Foundry guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude) for the Azure endpoint and authentication details.

## Google Gemini

Archestra supports both the [Google AI Studio](https://ai.google.dev/) (Gemini Developer API) and [Vertex AI](https://cloud.google.com/vertex-ai) implementations of the Gemini API.

### Supported Gemini APIs

- **Generate Content API** (`:generateContent`) - ✅ Fully supported
- **Stream Generate Content API** (`:streamGenerateContent`) - ✅ Fully supported

### Gemini Connection Details

- **Base URL**: `http://localhost:9000/v1/gemini/{profile-id}/v1beta`
- **Authentication**:
  - **Google AI Studio (default)**: Pass your Gemini API key in the `x-goog-api-key` header
  - **Vertex AI**: No API key required from clients - uses server-side [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

### Using Vertex AI

To use Vertex AI instead of Google AI Studio, configure these environment variables:

| Variable                                      | Required | Description                            |
| --------------------------------------------- | -------- | -------------------------------------- |
| `ARCHESTRA_GEMINI_VERTEX_AI_ENABLED`          | Yes      | Set to `true` to enable Vertex AI mode |
| `ARCHESTRA_GEMINI_VERTEX_AI_PROJECT`          | Yes      | Your GCP project ID                    |
| `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`         | No       | GCP region (default: `us-central1`)    |
| `ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE` | No       | Path to service account JSON key file  |

#### GKE with Workload Identity (Recommended)

For GKE deployments, we recommend using [Workload Identity](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity) which provides secure, keyless authentication. This eliminates the need for service account JSON key files.

**Setup steps:**

1. **Create a GCP service account** with Vertex AI permissions:

```bash
gcloud iam service-accounts create archestra-vertex-ai \
  --display-name="Archestra Vertex AI"

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:archestra-vertex-ai@PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"
```

2. **Bind the GCP service account to the Kubernetes service account**:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  archestra-vertex-ai@PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="serviceAccount:PROJECT_ID.svc.id.goog[NAMESPACE/KSA_NAME]"
```

Replace `NAMESPACE` with your Helm release namespace and `KSA_NAME` with the Kubernetes service account name (defaults to `archestra-platform`).

3. **Configure Helm values** to annotate the service account:

```yaml
archestra:
  orchestrator:
    kubernetes:
      serviceAccount:
        annotations:
          iam.gke.io/gcp-service-account: archestra-vertex-ai@PROJECT_ID.iam.gserviceaccount.com
  env:
    ARCHESTRA_GEMINI_VERTEX_AI_ENABLED: "true"
    ARCHESTRA_GEMINI_VERTEX_AI_PROJECT: "PROJECT_ID"
    ARCHESTRA_GEMINI_VERTEX_AI_LOCATION: "us-central1"
```

With this configuration, Application Default Credentials (ADC) will automatically use the bound GCP service account—no credentials file needed.

#### Other Environments

For non-GKE environments, Vertex AI supports several authentication methods through [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials):

- **Service account key file**: Set `ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE` to the path of a service account JSON key file
- **Local development**: Use `gcloud auth application-default login` to authenticate with your user account
- **Cloud environments**: Attached service accounts on Compute Engine, Cloud Run, and Cloud Functions are automatically detected
- **AWS/Azure**: Use workload identity federation to authenticate without service account keys

See the [Vertex AI authentication guide](https://cloud.google.com/vertex-ai/docs/authentication) for detailed setup instructions for each environment.

## Cerebras

[Cerebras](https://www.cerebras.ai/) provides fast inference for open-source AI models through an OpenAI-compatible API.

### Supported Cerebras APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported

### Cerebras Connection Details

- **Base URL**: `http://localhost:9000/v1/cerebras/{agent-id}`
- **Authentication**: Pass your Cerebras API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- Usage of the llama models in the chat ⚠️ Not yet supported ([GitHub Issue #2058](https://github.com/archestra-ai/archestra/issues/2058)) 

## Cohere

[Cohere](https://www.cohere.ai/) provides enterprise-grade LLMs designed for safe, controllable, and efficient AI applications. The platform offers features like safety guardrails, function calling, and both synchronous and streaming APIs.

### Supported Cohere APIs

- **Chat API** (`/chat`) - ✅ Fully supported
- **Streaming**: ✅ Fully supported

### Cohere Connection Details

- **Base URL**: `http://localhost:9000/v1/cohere/{profile-id}`
- **Authentication**: Pass your Cohere API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                        | Required | Description                                                                    |
| ------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_COHERE_BASE_URL`     | No       | Cohere API base URL (default: `https://api.cohere.ai`)                         |
| `ARCHESTRA_CHAT_COHERE_API_KEY` | No       | Default API key for Cohere (can be overridden per conversation/team/org)       |

### Important Notes

- **API Key format**: Obtain your API key from the [Cohere Dashboard](https://dashboard.cohere.ai/)

## Groq

[Groq](https://groq.com/) provides low-latency inference for popular open-source models through an OpenAI-compatible API.

### Supported Groq APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### Groq Connection Details

- **Base URL**: `http://localhost:9000/v1/groq/{profile-id}`
- **Authentication**: Pass your Groq API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                      | Required | Description                                                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------ |
| `ARCHESTRA_GROQ_BASE_URL`     | No       | Groq API base URL (default: `https://api.groq.com/openai/v1`)            |
| `ARCHESTRA_CHAT_GROQ_API_KEY` | No       | Default API key for Groq (can be overridden per conversation/team/org)   |

### Getting an API Key

You can generate an API key from the [Groq Console](https://console.groq.com/keys).

### Popular Models

- `llama-3.3-70b-versatile`
- `llama-3.1-8b-instant`
- `gemma2-9b-it`

### Important Notes

- **OpenAI-compatible API**: Groq uses the OpenAI Chat Completions request/response format, which makes it a good fit for existing OpenAI client libraries.
- **Base URL includes `/openai/v1`**: When configuring a custom Groq endpoint, ensure the base URL points to the OpenAI-compatible API root (for example, `https://api.groq.com/openai/v1`).

## OpenRouter

[OpenRouter](https://openrouter.ai/) provides access to many models via a single OpenAI-compatible API, with optional attribution headers for ranking and analytics.

### Supported OpenRouter APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)
- **Embeddings API** (`/embeddings`) - ✅ Supported for Knowledge Base embeddings

### OpenRouter Connection Details

- **Base URL**: `http://localhost:9000/v1/openrouter/{profile-id}`
- **Authentication**: Pass your OpenRouter API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                           | Required | Description                                                                 |
| ---------------------------------- | -------- | --------------------------------------------------------------------------- |
| `ARCHESTRA_OPENROUTER_BASE_URL`    | No       | OpenRouter API base URL (default: `https://openrouter.ai/api/v1`)           |
| `ARCHESTRA_CHAT_OPENROUTER_API_KEY`| No       | Default API key for OpenRouter (can be overridden per conversation/team/org)|
| `ARCHESTRA_OPENROUTER_REFERER`     | No       | Attribution header `HTTP-Referer` sent to OpenRouter (recommended)          |
| `ARCHESTRA_OPENROUTER_TITLE`       | No       | Attribution header `X-Title` sent to OpenRouter (recommended)               |

### Getting an API Key

You can generate an API key from the [OpenRouter dashboard](https://openrouter.ai/keys).

### Popular Models

- `openrouter/auto`
- `openrouter/openai/gpt-4o-mini`

### Important Notes

- **OpenAI-compatible API**: OpenRouter uses the OpenAI Chat Completions request/response format.
- **Attribution headers**: OpenRouter recommends sending `HTTP-Referer` and `X-Title` headers. Archestra can be configured to send these automatically via `ARCHESTRA_OPENROUTER_REFERER` and `ARCHESTRA_OPENROUTER_TITLE`.

## Mistral AI

[Mistral AI](https://mistral.ai/) provides state-of-the-art open and commercial AI models through an OpenAI-compatible API.

### Supported Mistral APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported

### Mistral Connection Details

- **Base URL**: `http://localhost:9000/v1/mistral/{agent-id}`
- **Authentication**: Pass your Mistral API key in the `Authorization` header as `Bearer <your-api-key>`

### Getting an API Key

You can get an API key from the [Mistral AI Console](https://console.mistral.ai/api-keys).

## Perplexity AI

[Perplexity AI](https://www.perplexity.ai/) provides AI-powered search and answer engines with real-time web search capabilities through an OpenAI-compatible API.

### Supported Perplexity APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported

### Perplexity Connection Details

- **Base URL**: `http://localhost:9000/v1/perplexity/{agent-id}`
- **Authentication**: Pass your Perplexity API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                            | Required | Description                                                                    |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_PERPLEXITY_BASE_URL`     | No       | Perplexity API base URL (default: `https://api.perplexity.ai`)                 |
| `ARCHESTRA_CHAT_PERPLEXITY_API_KEY` | No       | Default API key for Perplexity (can be overridden per conversation/team/org)   |

### Getting an API Key

You can get an API key from the [Perplexity Settings](https://www.perplexity.ai/settings/api).

### Important Notes

- **No tool calling support**: Perplexity does NOT support external tool calling. It performs internal web searches and returns results in the response. Use Perplexity for search-augmented generation, not agentic workflows requiring custom tools.
- **Search results**: Perplexity responses may include `search_results` and `citations` fields containing web search results used to generate the answer.
- **Models**: Popular models include `sonar-pro`, `sonar`, and `sonar-deep-research` for different use cases.

## vLLM

[vLLM](https://github.com/vllm-project/vllm) is a high-throughput and memory-efficient inference and serving engine for LLMs. It's ideal for self-hosted deployments where you want to run open-source models on your own infrastructure.

### Supported vLLM APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### vLLM Connection Details

- **Base URL**: `http://localhost:9000/v1/vllm/{profile-id}`
- **Authentication**: API key is **optional**. Pass in `Authorization` header as `Bearer <your-api-key>` if your vLLM deployment requires auth.

### Setup

1. Go to **Settings > LLM API Keys** and add a new key with provider **vLLM**
2. Set the **Base URL** to your vLLM server (e.g., `http://your-vllm-host:8000/v1`)
3. API key can be left blank for most self-hosted deployments

The base URL can also be set globally via the `ARCHESTRA_VLLM_BASE_URL` environment variable. Per-key base URLs in the UI take precedence.

### Environment Variables

| Variable                      | Required | Description                                                                    |
| ----------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_VLLM_BASE_URL`     | Yes      | vLLM server base URL (e.g., `http://localhost:8000/v1` or your vLLM endpoint)  |
| `ARCHESTRA_CHAT_VLLM_API_KEY` | No       | API key for vLLM server (optional, many deployments don't require auth) |

### Important Notes

- **Configure base URL to enable vLLM**: The vLLM provider is only available when `ARCHESTRA_VLLM_BASE_URL` is set or a per-key base URL is configured in the UI. Without either, vLLM won't appear as an option.
- **No API key required for most deployments**: Unlike cloud providers, self-hosted vLLM typically doesn't require authentication. When adding a vLLM key in the platform, the API key field is marked as optional.

## Ollama

[Ollama](https://ollama.ai/) is a local LLM runner that makes it easy to run open-source large language models on your machine. It's perfect for local development, testing, and privacy-conscious deployments.

### Supported Ollama APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### Ollama Connection Details

- **Base URL**: `http://localhost:9000/v1/ollama/{profile-id}`
- **Authentication**: API key is **optional**. Pass in `Authorization` header as `Bearer <your-api-key>` if your Ollama deployment requires auth (e.g., Ollama Cloud).

### Setup

1. Go to **Settings > LLM API Keys** and add a new key with provider **Ollama**
2. Optionally set the **Base URL** if your Ollama server runs on a non-default host/port
3. API key can be left blank for self-hosted Ollama

The default base URL is `http://localhost:11434/v1`. Override it per-key in the UI or globally via `ARCHESTRA_OLLAMA_BASE_URL`.

### Environment Variables

| Variable                        | Required | Description                                                                                  |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `ARCHESTRA_OLLAMA_BASE_URL`     | No       | Ollama server base URL (default: `http://localhost:11434/v1`)                                |
| `ARCHESTRA_CHAT_OLLAMA_API_KEY` | No       | API key for Ollama server (optional, should be used for the Ollama Cloud API)                |

### Important Notes

- **Enabled by default**: Ollama is enabled out of the box with a default base URL of `http://localhost:11434/v1`.
- **No API key required**: Self-hosted Ollama doesn't require authentication. When adding an Ollama key in the platform, the API key field is marked as optional.
- **Model availability**: Models must be pulled first using `ollama pull <model-name>` before they can be used through Archestra.

## Zhipu AI

[Zhipu AI (Z.ai)](https://z.ai/) is a Chinese AI company offering the GLM (General Language Model) series of large language models. The platform provides both free and commercial models with strong performance in Chinese and English language tasks.

### Supported Zhipu AI APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### Zhipu AI Connection Details

- **Base URL**: `http://localhost:9000/v1/zhipuai/{profile-id}`
- **Authentication**: Pass your Zhipu AI API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                          | Required | Description                                                                    |
| --------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_ZHIPUAI_BASE_URL`      | No       | Zhipu AI API base URL (default: `https://api.z.ai/api/paas/v4`)       |
| `ARCHESTRA_CHAT_ZHIPUAI_API_KEY`  | No       | Default API key for Zhipu AI (can be overridden per conversation/team/org)    |

### Popular Models

- **GLM-4.5-Flash** (Free tier) - Fast inference model with good performance
- **GLM-4.5** - Balanced model for general use
- **GLM-4.5-Air** - Lightweight model optimized for speed
- **GLM-4.6** - Enhanced version with improved capabilities
- **GLM-4.7** - Latest model with advanced features

### Important Notes

- **OpenAI-compatible API**: Zhipu AI's API follows the OpenAI Chat Completions format, making it easy to switch between providers
- **API Key format**: Obtain your API key from the [Zhipu AI Platform](https://z.ai/)
- **Free tier available**: The GLM-4.5-Flash model is available on the free tier for testing and development
- **Chinese language support**: GLM models excel at Chinese language understanding and generation, while maintaining strong English capabilities

## xAI (Grok)

[xAI](https://x.ai/) is Elon Musk's AI company offering the Grok series of large language models with real-time information access and advanced reasoning capabilities.

### Supported xAI APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### xAI Connection Details

- **Base URL**: `http://localhost:9000/v1/xai/{profile-id}`
- **Authentication**: Pass your xAI API key in `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                     | Required | Description                                                                    |
| ---------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_XAI_BASE_URL`     | No       | xAI API base URL (default: `https://api.x.ai/v1`)                             |
| `ARCHESTRA_CHAT_XAI_API_KEY` | No       | Default API key for xAI (can be overridden per conversation/team/org)       |

### Getting an API Key

You can generate an API key from the [xAI Console](https://console.x.ai/).

### Popular Models

- `grok-2-latest` - Latest Grok model with enhanced capabilities
- `grok-2-mini` - Lightweight variant optimized for speed
- `grok-beta` - Beta version with experimental features

### Important Notes

- **OpenAI-compatible API**: xAI's API follows the OpenAI Chat Completions format, making it easy to switch between providers
- **Real-time information**: Grok models have access to real-time information from X (Twitter) for up-to-date responses
- **API Key format**: Obtain your API key from the [xAI Console](https://console.x.ai/)
- **Rate limits**: Be mindful of xAI's rate limits when implementing high-volume applications

## MiniMax

[MiniMax](https://www.minimax.io/) is a Chinese AI company offering advanced large language models with strong reasoning capabilities. The platform provides the MiniMax-M2 series with chain-of-thought reasoning capabilities and support for text, images, and multi-turn conversations.

### Supported MiniMax APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### MiniMax Connection Details

- **Base URL**: `http://localhost:9000/v1/minimax/{profile-id}`
- **Authentication**: Pass your MiniMax API key in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                          | Required | Description                                                                    |
| --------------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_CHAT_MINIMAX_API_KEY`  | No       | Default API key for MiniMax (can be overridden per conversation/team/org)     |
| `ARCHESTRA_CHAT_MINIMAX_BASE_URL` | No       | MiniMax API base URL (default: `https://api.minimax.io/v1`)                   |

### Available Models

- **MiniMax-M2** - Base model with strong reasoning capabilities ($0.3/$1.2 per M tokens)
- **MiniMax-M2.1** - Enhanced model with improved performance ($0.3/$1.2 per M tokens)
- **MiniMax-M2.1-lightning** - Fast inference variant of M2.1 ($0.6/$2.4 per M tokens)
- **MiniMax-M2.5** - Latest model with enhanced capabilities ($0.3/$1.2 per M tokens)
- **MiniMax-M2.5-highspeed** - Fast inference variant of M2.5 ($0.6/$2.4 per M tokens)

### Important Notes

- **OpenAI-compatible API (text-only)**: MiniMax's API follows the OpenAI Chat Completions format for easy integration. The integration uses text-only messages (no image or multimodal content support).
- **Reasoning metadata**: MiniMax models support extended thinking through the `reasoning_details` field in responses, which contains the model's reasoning process as structured data (not as `<think>` tags in the message content).
- **API Key**: Obtain your API key from the [MiniMax Platform](https://www.minimax.io/)
- **No /models endpoint**: MiniMax does not provide a models listing API. Available models are hardcoded in the platform configuration
- **Chinese and English support**: MiniMax models excel at both Chinese and English language tasks

## Amazon Bedrock

### Supported Bedrock APIs

- **Converse API** (`/converse`) - ✅ Fully supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html))
- **Converse Stream API** (`/converse-stream`) - ✅ Fully supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html))
- **InvokeModel API** (`/invoke`) -  ⚠️ Not yet supported  ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html))
- **OpenAI-compatible API (Mantle)** -  ⚠️ Not yet supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html))

### Bedrock Connection Details

- **Base URL**: `http://localhost:9000/v1/bedrock/{profile-id}`
- **Authentication**: Bearer API key or AWS IAM (see below)

### Authentication Methods

Bedrock supports two authentication methods:

**API Key** (default) — Pass your [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) via the UI or `ARCHESTRA_CHAT_BEDROCK_API_KEY` env var.

**AWS IAM** — Use the AWS credential chain (IRSA, instance profiles, environment variables) instead of API keys. When enabled, Archestra authenticates to Bedrock using SigV4 signing. No API key is needed — Bedrock appears as a system-configured provider automatically.

### IAM Authentication Setup (IRSA)

To use IAM authentication on EKS with [IRSA](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html):

1. Create an IAM role with `AmazonBedrockFullAccess` or a scoped policy (see below)
2. Create an [OIDC provider](https://docs.aws.amazon.com/eks/latest/userguide/enable-iam-roles-for-service-accounts.html) for your EKS cluster
3. Configure the IAM role's trust policy to allow the Archestra service account:
   ```json
   {
     "Effect": "Allow",
     "Principal": {
       "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/oidc.eks.<REGION>.amazonaws.com/id/<OIDC_ID>"
     },
     "Action": "sts:AssumeRoleWithWebIdentity",
     "Condition": {
       "StringEquals": {
         "oidc.eks.<REGION>.amazonaws.com/id/<OIDC_ID>:sub": "system:serviceaccount:archestra:archestra-platform"
       }
     }
   }
   ```
4. Annotate the Archestra service account:
   ```bash
   kubectl annotate sa archestra-platform -n archestra \
     eks.amazonaws.com/role-arn=arn:aws:iam::<ACCOUNT_ID>:role/<ROLE_NAME>
   ```
5. Set the environment variables below and restart the deployment

#### Minimum IAM Policy

Archestra uses the Bedrock **Converse API** (not InvokeModel). The IAM role needs these actions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:Converse", "bedrock:ConverseStream"],
      "Resource": [
        "arn:aws:bedrock:*:<ACCOUNT_ID>:inference-profile/us.anthropic.*",
        "arn:aws:bedrock:*::foundation-model/anthropic.*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:ListInferenceProfiles"],
      "Resource": "*"
    }
  ]
}
```

Use `*` for the region in resource ARNs — cross-region inference profiles (`us.` prefix) can route requests to any US region.

### Environment Variables

#### Common (both auth methods)

| Variable                                 | Required | Description                                                                          |
| ---------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `ARCHESTRA_BEDROCK_BASE_URL`             | Yes      | Bedrock runtime endpoint URL (e.g., `https://bedrock-runtime.us-east-1.amazonaws.com`) |
| `ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS`    | No       | Comma-separated list of provider prefixes to include. When empty (default), all profiles are returned. |
| `ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS` | No | Comma-separated list of inference region prefixes (e.g., `us,global`). When empty (default), all regions are returned. |

#### API Key auth

| Variable                         | Required | Description                                                        |
| -------------------------------- | -------- | ------------------------------------------------------------------ |
| `ARCHESTRA_CHAT_BEDROCK_API_KEY` | No       | Default API key for Bedrock (can be overridden per team/org in UI) |

#### IAM auth (IRSA / instance profiles)

| Variable                             | Required | Description                                                              |
| ------------------------------------ | -------- | ------------------------------------------------------------------------ |
| `ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED` | Yes      | Set to `true` to enable IAM authentication                               |
| `ARCHESTRA_BEDROCK_REGION`           | No       | Explicit AWS region. Falls back to extracting from base URL               |

When IAM auth is enabled, Archestra uses the [AWS credential chain](https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html) — IRSA on EKS, EC2 instance profiles, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars. No API key is needed.

#### `ARCHESTRA_BEDROCK_BASE_URL`

**Required** to enable the Bedrock provider. The URL format follows AWS regional endpoints:

```
https://bedrock-runtime.{region}.amazonaws.com
```

#### Model Discovery

Archestra uses the Bedrock [ListInferenceProfiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html) API to discover available models. This means only models that have inference profiles configured in your AWS account will appear — ensuring the model picker only shows models you can actually use.

#### Filtering Models by Provider

By default, Archestra returns all active inference profiles from your AWS account. Use `ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS` to limit which providers appear in the model picker.

The filter matches the provider segment of the inference profile ID (the part after the region prefix). For example, the profile `us.anthropic.claude-sonnet-4-6` has provider `anthropic`.

```bash
# Only Anthropic and Amazon models
ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS=anthropic,amazon

# Only Anthropic models
ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS=anthropic

# All providers (default)
ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS=
```

Common provider prefixes: `anthropic`, `amazon`, `meta`, `mistral`, `deepseek`, `cohere`, `writer`, `stability`, `twelvelabs`.

#### Filtering Models by Inference Region

Use `ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS` to limit which inference
regions appear in the model picker.

The filter matches the region prefix of the inference profile ID (the first
segment before the provider). For example, the profile
`us.anthropic.claude-sonnet-4-6` has region prefix `us`.

```bash
# Only US and global profiles
ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS=us,global

# Only EU profiles
ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS=eu

# All regions (default)
ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS=
```

Known region prefixes: `us`, `eu`, `ap`, `global`.

## Azure AI Foundry

[Azure AI Foundry](https://azure.microsoft.com/en-us/products/ai-foundry) (formerly Azure OpenAI) provides enterprise-grade access to OpenAI models through Microsoft Azure, with an OpenAI-compatible API.

### Supported Azure AI Foundry APIs

- Chat Completions (streaming and non-streaming)
- Responses API (streaming and non-streaming)

### Azure AI Foundry Connection Details

- **Base URL**: `http://localhost:9000/v1/azure/{profile-id}`
- **API key authentication**: Pass your Azure API key in the `Authorization` header as `Bearer <your-api-key>`
- **Keyless authentication**: Set `ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true` and assign the workload identity, managed identity, service principal, or local Azure CLI user an Azure role that can invoke the deployed model.

### Azure AI Foundry Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ARCHESTRA_AZURE_OPENAI_BASE_URL` | Yes | Azure OpenAI deployment URL or Foundry v1 URL |
| `ARCHESTRA_AZURE_OPENAI_API_VERSION` | No | Azure OpenAI API version (default: `2024-02-01`) |
| `ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION` | No | Azure Responses API version (default: `2025-04-01-preview`) |
| `ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED` | No | Set to `true` to use Microsoft Entra ID instead of an Azure API key |
| `ARCHESTRA_CHAT_AZURE_OPENAI_API_KEY` | No | Default API key for Azure AI Foundry chat (can be overridden per conversation/team/org) |

### Getting an Azure API Key

You can generate an API key from the [Azure Portal](https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI) under your Azure OpenAI resource.

### Keyless Authentication with Microsoft Entra ID

To use Azure OpenAI without storing an API key, set:

```bash
ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true
ARCHESTRA_AZURE_OPENAI_BASE_URL=https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>
```

For Foundry v1, use:

```bash
ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true
ARCHESTRA_AZURE_OPENAI_BASE_URL=https://<resource-name>.services.ai.azure.com/openai/v1
```

Archestra uses Azure Identity `DefaultAzureCredential`. Deployment URLs use the `https://cognitiveservices.azure.com/.default` token scope. Foundry v1 URLs use `https://ai.azure.com/.default`. Assign the workload identity, managed identity, service principal, or local Azure CLI user a role that can invoke the Azure resource.

See the [Azure OpenAI keyless example](https://github.com/archestra-ai/examples/tree/main/azure-openai-keyless) for a minimal local script that uses the same authentication flow.
See Microsoft's [Foundry Models Entra ID guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id) and [Foundry Models endpoint guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints) for the Azure endpoint formats and token scopes.

#### AKS with Microsoft Entra Workload ID

For AKS deployments, use [Microsoft Entra Workload ID](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview) with a user-assigned managed identity. Microsoft documents that Azure Identity `DefaultAzureCredential` uses the workload identity environment injected into the pod.

Enable OIDC issuer and workload identity on the AKS cluster, create a federated identity credential for the Archestra Kubernetes service account, and grant the managed identity the inference role required by the resource: `Cognitive Services OpenAI User` for Azure OpenAI deployment URLs, or `Cognitive Services User` for Foundry Models. The service account subject must match the namespace and service account name used by the Helm release:

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
    ARCHESTRA_AZURE_OPENAI_BASE_URL: "https://<resource-name>.services.ai.azure.com/openai/v1"
```

See Microsoft's [AKS Workload ID deployment guide](https://learn.microsoft.com/en-us/azure/aks/workload-identity-deploy-cluster) for the full cluster, service account, and federated credential setup.

### Base URL Format

For Azure OpenAI deployment URLs, include the deployment name:

```
https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>
```

For example: `https://my-company.openai.azure.com/openai/deployments/gpt-4o`

For Microsoft Foundry v1, use the OpenAI-compatible API root:

```
https://<resource-name>.services.ai.azure.com/openai/v1
```

The same format applies when configuring a Base URL in the API key settings UI.

### Notes

- **API Version**: Deployment URLs use `ARCHESTRA_AZURE_OPENAI_API_VERSION` for Chat Completions and model discovery. Azure `/responses` requests use `ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`. Foundry v1 URLs do not use either query parameter.
- **Microsoft Entra ID**: When `ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true`, Archestra creates a system provider key at startup and sends `Authorization: Bearer <token>` to Azure OpenAI instead of `api-key`.
- **Grok on Azure**: Grok models sold directly by Azure use the Foundry v1 OpenAI-compatible Chat Completions API. The model must be deployed in the Azure resource before Archestra can route to it.
- **Claude on Azure**: Claude models on Microsoft Foundry use Anthropic's Messages API shape, not the OpenAI-compatible Azure route. Configure the Anthropic provider section above.
- **Multiple Deployments**: With deployment URLs, create separate API key entries in Settings, each with its own deployment URL as the Base URL. With Foundry v1, send the deployed model name in the request `model` field.
- **Deployment URL configuration**: Keep using the deployment-specific base URL format shown above. Archestra derives the correct upstream endpoint automatically for both `/chat/completions` and `/responses` requests.
- **Responses API model field**: For Azure `/responses` requests, send the deployment name in the `model` field. Archestra will route the request to Azure's `/openai/responses` endpoint while preserving the configured deployment URL for discovery and management.
- **OpenAI-compatible API**: Azure AI Foundry supports both Chat Completions and Responses-style request flows through Archestra.
