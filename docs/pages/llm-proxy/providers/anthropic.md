---
title: Anthropic
description: Connect Claude with an Anthropic API key, Microsoft Foundry, Vertex AI, or workload identity federation.
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use Claude with an Anthropic API key, or through your Microsoft Foundry or Google Vertex AI account. With workload identity federation, Archestra stores no Anthropic key at all.

## Adding a Provider

Go to **Model Providers → Add API Key**, select **Anthropic**, and configure the credentials described below. Click **Test & Create**. A successful test adds the key and makes its models available under **Models**.

## Proxy Endpoint

- **Base URL**: `https://<archestra-host>/v1/anthropic`
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header
- **Messages path**: `POST /v1/anthropic/v1/messages`

### Claude Code Features Through the Proxy

New Claude Code features work through the proxy with no setup. One example is auto mode with its no-charge, server-side safety checks. The proxy sends request fields and `anthropic-beta` values to the provider unchanged. It also returns response keys and stream events that it does not recognize. This applies on Anthropic, Microsoft Foundry, Vertex AI, and [Amazon Bedrock](/docs/llm-proxy/providers/bedrock).

If Claude Code says "this session isn't eligible" for auto mode's no-charge checks, update Archestra. Older versions removed the fields that these checks use. See Anthropic's [auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing) page for what the notice means.

### Anthropic on Microsoft Foundry

Claude models deployed in Microsoft Foundry use the Anthropic Messages API at `https://<resource>.services.ai.azure.com/anthropic`. Set [`ARCHESTRA_ANTHROPIC_BASE_URL`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_BASE_URL) to that `/anthropic` base URL. For keyless Microsoft Entra ID authentication, also set [`ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED); Archestra sends a bearer token scoped to `https://ai.azure.com/.default`.

Claude Foundry deployments must exist in Azure before requests will work. Use the deployed Claude model name in the Anthropic `model` field. Microsoft lists extra Claude prerequisites: a paid eligible Azure subscription, a supported region such as East US2 or Sweden Central, Azure Marketplace access for partner models, permission to subscribe to model offerings, and Contributor or Owner role on the resource group.

Azure requires Anthropic deployment metadata when creating Claude deployments: `industry`, `organizationName`, and `countryCode`. In Azure CLI this may require an ARM REST deployment call with `properties.modelProviderData`.

See Microsoft's [Claude on Foundry guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude) for the Azure endpoint and authentication details.

### Anthropic on Vertex AI

Archestra can use Claude models published through Google Vertex AI. This mode uses Application Default Credentials and requires no Anthropic API key.

Set [`ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT) to enable this mode. Unset or blank disables it. The default location is `global`. Archestra discovers Claude models from Model Garden and adds them to the Anthropic model picker.

Enable each Claude model in Model Garden before using it. Google may require accepting provider terms during activation.

See the [deployment environment variables](/docs/reference/configuration) for the full configuration.

### Workload Identity Federation (keyless)

Archestra can authenticate to the Anthropic API without a static API key using [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation): it exchanges a short-lived OIDC identity token from your identity provider (Kubernetes, AWS, GCP, Entra ID, GitHub Actions, and others) for an Anthropic access token and sends it as `Authorization: Bearer` upstream. Tokens are cached and refreshed automatically before expiry.

Configure a federation issuer, service account, and federation rule in the Claude Console (**Settings → Workload identity**), then set the `ARCHESTRA_ANTHROPIC_*` WIF environment variables — see [Environment Variables](/docs/reference/configuration) in the deployment docs. When configured, Archestra creates an "Anthropic Workload Identity Federation" system key automatically and syncs the available Claude models; users can also create Anthropic provider keys without entering an API key.

Note: the SDK-standard `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` environment variables take precedence over federation if present in the backend environment, matching Anthropic's documented credential precedence.
