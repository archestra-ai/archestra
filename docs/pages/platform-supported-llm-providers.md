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
| `ARCHESTRA_GEMINI_VERTEX_AI_LOCATION` | No | GCP region (default: `us-central1`) |
| `ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE` | No | Path to service account JSON key file |

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

