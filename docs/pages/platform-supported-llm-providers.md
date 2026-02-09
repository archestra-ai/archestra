---
title: Supported LLM Providers
category: Archestra Platform
order: 3
description: LLM providers supported by Archestra Platform
lastUpdated: 2026-01-14
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is human-built, shouldn't be updated with AI. Don't change anything here.
-->

## Overview

Archestra Platform acts as a security proxy between your AI applications and LLM providers. It currently supports the following LLM providers.

## OpenAI

### Supported OpenAI APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported
- **Responses API** (`/responses`) - ⚠️ Not yet supported ([GitHub Issue #720](https://github.com/archestra-ai/archestra/issues/720))

### OpenAI Connection Details

- **Base URL**: `http://localhost:9000/v1/openai/{profile-id}`
- **Authentication**: Pass your OpenAI API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- **Use Chat Completions API**: Ensure your application uses the `/chat/completions` endpoint (not `/responses`). Many frameworks default to this, but some like Vercel AI SDK require explicit configuration (add `.chat` to the provider instance).
- **Streaming**: OpenAI streaming responses require your cloud provider's load balancer to support long-lived connections. See [Cloud Provider Configuration](/docs/platform-deployment#cloud-provider-configuration-streaming-timeout-settings) for more details.

## Anthropic

### Supported Anthropic APIs

- **Messages API** (`/messages`) - ✅ Fully supported

### Anthropic Connection Details

- **Base URL**: `http://localhost:9000/v1/anthropic/{profile-id}`
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header

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

## Mistral AI

[Mistral AI](https://mistral.ai/) provides state-of-the-art open and commercial AI models through an OpenAI-compatible API.

### Supported Mistral APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported

### Mistral Connection Details

- **Base URL**: `http://localhost:9000/v1/mistral/{agent-id}`
- **Authentication**: Pass your Mistral API key in the `Authorization` header as `Bearer <your-api-key>`

### Getting an API Key

You can get an API key from the [Mistral AI Console](https://console.mistral.ai/api-keys).

## vLLM

[vLLM](https://github.com/vllm-project/vllm) is a high-throughput and memory-efficient inference and serving engine for LLMs. It's ideal for self-hosted deployments where you want to run open-source models on your own infrastructure.

### Supported vLLM APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### vLLM Connection Details

- **Base URL**: `http://localhost:9000/v1/vllm/{profile-id}`
- **Authentication**: Pass your vLLM API key (if configured) in the `Authorization` header as `Bearer <your-api-key>`. Many vLLM deployments don't require authentication.

### Environment Variables

| Variable                      | Required | Description                                                                    |
| ----------------------------- | -------- | ------------------------------------------------------------------------------ |
| `ARCHESTRA_VLLM_BASE_URL`     | Yes      | vLLM server base URL (e.g., `http://localhost:8000/v1` or your vLLM endpoint)  |
| `ARCHESTRA_CHAT_VLLM_API_KEY` | No       | API key for vLLM server (optional, many deployments don't require auth) |

### Important Notes

- **Configure base URL to enable vLLM**: The vLLM provider is only available when `ARCHESTRA_VLLM_BASE_URL` is set. Without it, vLLM won't appear as an option in the platform.
- **No API key required for most deployments**: Unlike cloud providers, self-hosted vLLM typically doesn't require authentication. The `ARCHESTRA_CHAT_VLLM_API_KEY` is only needed if your vLLM deployment has authentication enabled.

## Ollama

[Ollama](https://ollama.ai/) is a local LLM runner that makes it easy to run open-source large language models on your machine. It's perfect for local development, testing, and privacy-conscious deployments.

### Supported Ollama APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported (OpenAI-compatible)

### Ollama Connection Details

- **Base URL**: `http://localhost:9000/v1/ollama/{profile-id}`
- **Authentication**: Pass your Ollama API key (if configured) in the `Authorization` header as `Bearer <your-api-key>`. Ollama typically doesn't require authentication.

### Environment Variables

| Variable                        | Required | Description                                                                                  |
| ------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `ARCHESTRA_OLLAMA_BASE_URL`     | No       | Ollama server base URL (default: `http://localhost:11434/v1`)                                |
| `ARCHESTRA_CHAT_OLLAMA_API_KEY` | No       | API key for Ollama server (optional, should be used for the Ollama Cloud API)                |

### Important Notes

- **Enabled by default**: Ollama is enabled out of the box with a default base URL of `http://localhost:11434/v1`. Set `ARCHESTRA_OLLAMA_BASE_URL` to override the default if your Ollama server runs on a different host or port.
- **No API key required**: Self-hosted Ollama typically doesn't require authentication. When adding an Ollama API key in the platform, the API key field is optional.
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

## Amazon Bedrock

### Supported Bedrock APIs

- **Converse API** (`/converse`) - ✅ Fully supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html))
- **Converse Stream API** (`/converse-stream`) - ✅ Fully supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html))
- **InvokeModel API** (`/invoke`) -  ⚠️ Not yet supported  ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html))
- **OpenAI-compatible API (Mantle)** -  ⚠️ Not yet supported ([AWS Docs](https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-mantle.html))

### Bedrock Connection Details

- **Base URL**: `http://localhost:9000/v1/bedrock/{profile-id}`
- **Authentication**: Pass your [Amazon Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) in the `Authorization` header as `Bearer <your-api-key>`

### Environment Variables

| Variable                                     | Required | Description                                                                                     |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `ARCHESTRA_BEDROCK_BASE_URL`                 | Yes      | Bedrock runtime endpoint URL (e.g., `https://bedrock-runtime.us-east-1.amazonaws.com`)          |
| `ARCHESTRA_BEDROCK_INFERENCE_PROFILE_PREFIX` | No       | Region prefix for cross-region inference profiles (e.g., `us` or `eu`)                          |
| `ARCHESTRA_CHAT_BEDROCK_API_KEY`             | No       | Default API key for Bedrock (can be overridden per conversation/team/org)                       |

#### `ARCHESTRA_BEDROCK_BASE_URL`

This variable is **required** to enable the Bedrock provider. It specifies the regional endpoint for the Bedrock Runtime API. The URL format follows AWS regional endpoints:

```
https://bedrock-runtime.{region}.amazonaws.com
```

#### `ARCHESTRA_BEDROCK_INFERENCE_PROFILE_PREFIX`

Some Bedrock models, such as Anthropic's Claude, require [cross-region inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html). Set this variable to enable those models. If not set, only models with on-demand inference support will be available.

For more details, see [how inference works in Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-how.html).
