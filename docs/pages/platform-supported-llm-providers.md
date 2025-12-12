---
title: Supported LLM Providers
category: Archestra Platform
order: 3
description: LLM providers supported by Archestra Platform
lastUpdated: 2025-12-11
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

- **Base URL**: `http://localhost:9000/v1/openai/{agent-id}`
- **Authentication**: Pass your OpenAI API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- **Use Chat Completions API**: Ensure your application uses the `/chat/completions` endpoint (not `/responses`). Many frameworks default to this, but some like Vercel AI SDK require explicit configuration (add `.chat` to the provider instance).
- **Streaming**: OpenAI streaming responses require your cloud provider's load balancer to support long-lived connections. See [Cloud Provider Configuration](/docs/platform-deployment#cloud-provider-configuration-streaming-timeout-settings) for more details.


## Anthropic

### Supported Anthropic APIs

- **Messages API** (`/messages`) - ✅ Fully supported

### Anthropic Connection Details

- **Base URL**: `http://localhost:9000/v1/anthropic/{agent-id}`
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header

## Google Gemini

Archestra supports both the [Google AI Studio](https://ai.google.dev/) (Gemini Developer API) and [Vertex AI](https://cloud.google.com/vertex-ai) implementations of the Gemini API.

### Supported Gemini APIs

- **Generate Content API** (`:generateContent`) - ✅ Fully supported
- **Stream Generate Content API** (`:streamGenerateContent`) - ✅ Fully supported

### Gemini Connection Details

- **Base URL**: `http://localhost:9000/v1/gemini/{agent-id}/v1beta`
- **Authentication**:
  - **Google AI Studio (default)**: Pass your Gemini API key in the `x-goog-api-key` header
  - **Vertex AI**: No API key required from clients - uses server-side [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

### Important Notes

- **API Version**: Archestra uses the `v1beta` Gemini API version for feature parity with the latest Gemini capabilities.
- **Tool Support**: Function calling (tool use) is fully supported, including tool invocation policies and trusted data policies.

### Using Vertex AI

To use Vertex AI instead of Google AI Studio, configure these environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `ARCHESTRA_GEMINI_VERTEX_AI_ENABLED` | Yes | Set to `true` to enable Vertex AI mode |
| `ARCHESTRA_GEMINI_VERTEX_AI_PROJECT` | Yes | Your GCP project ID |
| `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION` | No | GCP region (default: `global`) |
| `ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE` | No | Path to service account JSON key file |

#### GKE with Workload Identity (Recommended)

For GKE deployments, we recommend using [Workload Identity](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity) which provides secure, keyless authentication:

1. Create a GCP service account with Vertex AI permissions (`roles/aiplatform.user`)
2. Bind it to the Kubernetes service account via Workload Identity
3. Set `ARCHESTRA_GEMINI_VERTEX_AI_ENABLED=true`, `ARCHESTRA_GEMINI_VERTEX_AI_PROJECT`, and `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`

No credentials file is needed - ADC automatically uses the bound service account.

#### Other Environments

For non-GKE environments or when Workload Identity isn't available, set `ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE` to the path of a service account JSON key file.

