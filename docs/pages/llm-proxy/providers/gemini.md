---
title: Google Gemini
description: Connect Gemini using Google AI Studio or Vertex AI.
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use Gemini through Google AI Studio with an API key, or through Vertex AI with no key. On GKE, Archestra signs in to Vertex AI with Workload Identity.

## Adding a Provider

Go to **Model Providers → Add API Key**, select **Google Gemini**, and configure the credentials described below. Click **Test & Create**. A successful test adds the key and makes its models available under **Models**.

Archestra supports both the [Google AI Studio](https://ai.google.dev/) (Gemini Developer API) and [Vertex AI](https://cloud.google.com/vertex-ai) implementations of the Gemini API.

### Gemini Connection Details

- **Base URL**: `https://<archestra-host>/v1/gemini/v1beta`
- **Authentication**:
  - **Google AI Studio (default)**: Pass your Gemini API key in the `x-goog-api-key` header
  - **Vertex AI**: No API key required from clients - uses server-side [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials)

### Using Vertex AI

To use Vertex AI instead of Google AI Studio, configure these environment variables:

| Variable                                      | Required | Description                            |
| --------------------------------------------- | -------- | -------------------------------------- |
| [`ARCHESTRA_GEMINI_VERTEX_AI_ENABLED`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_ENABLED)          | Yes      | Set to `true` to enable Vertex AI mode |
| [`ARCHESTRA_GEMINI_VERTEX_AI_PROJECT`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_PROJECT)          | Yes      | Your GCP project ID                    |
| [`ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_LOCATION)         | No       | GCP region (default: `us-central1`)    |
| [`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE) | No       | Path to service account JSON key file  |

Vertex AI mode also gives Knowledge access to Vertex's multimodal embedding model (`multimodalembedding@001`) — see [Image Embedding](/docs/knowledge/settings#image-embedding).

### GKE with Workload Identity (Recommended)

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

### Other Environments

For non-GKE environments, Vertex AI supports several authentication methods through [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials):

- **Service account key file**: Set [`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE) to the path of a service account JSON key file
- **Local development**: Use `gcloud auth application-default login` to authenticate with your user account
- **Cloud environments**: Attached service accounts on Compute Engine, Cloud Run, and Cloud Functions are automatically detected
- **AWS/Azure**: Use workload identity federation to authenticate without service account keys

See the [Vertex AI authentication guide](https://cloud.google.com/vertex-ai/docs/authentication) for detailed setup instructions for each environment.
