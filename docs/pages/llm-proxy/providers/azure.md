---
title: Azure AI Foundry
description: Connect Azure model deployments with an API key or Microsoft Entra ID
order: 2
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use the models you deployed in Azure, with an API key or with no key at all through Microsoft Entra ID. Each deployment name becomes a model ID, so `gpt-5-prod` in Azure is `gpt-5-prod` in your requests.

<span id="adding-a-provider"></span><span id="proxy-endpoint"></span><span id="getting-an-azure-api-key"></span><span id="base-url-format"></span>

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

Your deployments show under **Models**. Clients call `https://<archestra-host>/v1/azure` with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys), or with the Azure key as `Authorization: Bearer`.

One provider key covers the whole resource. Do not add a key for each deployment.

<span id="keyless-authentication-with-microsoft-entra-id"></span>

## Sign In Without a Key

Let Archestra sign in to Azure as itself, so no Azure key is stored anywhere. It uses Azure's `DefaultAzureCredential`: a workload identity, a managed identity, a service principal, or your local Azure CLI sign-in.

1. Set [`ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED).
2. Give that identity a role on the Azure resource: **Cognitive Services OpenAI User** for Azure OpenAI, or **Cognitive Services User** for Foundry Models.
3. Add Azure as above, with the API key empty.

To try the flow on your laptop first, see the [keyless example](https://github.com/archestra-ai/examples/tree/main/azure-openai-keyless).

<span id="aks-with-microsoft-entra-workload-id"></span>

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

Then set the identity and the pod label in your Helm values:

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

<span id="deployment-discovery-and-rbac"></span><span id="routing-notes"></span>

## When It Does Not Work

| You see | Do this |
| --- | --- |
| No models after **Test & Create** | Check that **Base URL** is the resource, not a deployment URL. With Entra ID, give the identity **Cognitive Services OpenAI User** on the backing Azure AI Services resource, at its full resource scope. |
| A model you see in Azure is missing | Deploy it first. Archestra lists deployments, not the model catalog. |
| A Claude model fails | Claude on Foundry uses Anthropic's API. Add it as the [Anthropic provider](/docs/llm-proxy/providers/anthropic#anthropic-on-microsoft-foundry). |
| An Azure API version error | Set [`ARCHESTRA_AZURE_OPENAI_API_VERSION`](/docs/reference/configuration#ARCHESTRA_AZURE_OPENAI_API_VERSION), or [`ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`](/docs/reference/configuration#ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION) for `/responses`. Foundry v1 URLs use neither. |

## What to Know

- **Narrowest access:** use a custom role with `Microsoft.Resources/subscriptions/read`, `Microsoft.Resources/subscriptions/resources/read`, `Microsoft.CognitiveServices/accounts/read`, and `Microsoft.CognitiveServices/accounts/deployments/read`.
- **Discovery and requests on different endpoints:** set `inferenceBaseUrl` on the provider key through the API. Archestra lists deployments from **Base URL** and sends every request to the inference URL.
- **Grok on Azure** works through a Foundry v1 URL, once the model is deployed.
