---
title: Anthropic
description: Connect Claude with an Anthropic API key, Microsoft Foundry, Vertex AI, or workload identity federation.
order: 3
lastUpdated: 2026-10-08
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use Claude with an Anthropic API key, or through your Microsoft Foundry or Google Vertex AI account. With workload identity federation, Archestra stores no Anthropic key at all.

## Adding a Provider

Go to **Model Providers → Add API Key**, select **Anthropic**, and configure the credentials described below. Click **Test & Create**. A successful test adds the key and makes its models available under **Models**.

## Proxy Endpoint

- **Base URL**: `https://<archestra-host>/v1/anthropic`
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header
- **Messages path**: `POST /v1/anthropic/v1/messages`

### Claude Code Auto Mode

Claude Code's auto mode uses the provider's server-side safety checks through the proxy. Where the provider runs these checks, Claude Code makes no separate classifier requests, so you do not pay for them. This works on every Anthropic option on this page and on [Amazon Bedrock](/docs/llm-proxy/providers/bedrock). See Anthropic's [auto mode classifier request charges](https://code.claude.com/docs/en/auto-mode-classifier-billing) for which platforms run the checks.

### Anthropic on Microsoft Foundry

Use the Claude deployments in your Microsoft Foundry resource, billed through Azure. Archestra lists the resource's Claude deployments, so you pick them like any other Anthropic model.

1. Deploy a Claude model in Foundry. Microsoft's [Claude on Foundry guide](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-claude) lists the subscription, region, and Marketplace requirements.
2. Go to **Model Providers → Add API Key** and select **Anthropic**.
3. Paste the Foundry resource key. Under **Advanced**, set **Base URL** to `https://<resource>.services.ai.azure.com/anthropic`.
4. Click **Test & Create**. The key's models are your Claude deployments, listed by deployment name.

- Requests name the deployment, not the Claude model ID. On the [Model Router](/docs/llm-proxy/model-router), call `anthropic:<deployment-name>`, and map this key on your [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys).
- Do not add Claude under the [Azure AI Foundry](/docs/llm-proxy/providers/azure) provider. That provider uses the OpenAI API, and Foundry answers Claude requests there with `404 Requested API is currently not supported`.
- For keyless Microsoft Entra ID authentication, set [`ARCHESTRA_ANTHROPIC_BASE_URL`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_BASE_URL) to the `/anthropic` URL and [`ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED). Keyless works with this server-wide URL only, not with a key's **Base URL**.

### Anthropic on Vertex AI

Archestra can use Claude models published through Google Vertex AI. This mode uses Application Default Credentials and requires no Anthropic API key.

Set [`ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT) to enable this mode. Unset or blank disables it. The default location is `global`. Archestra discovers Claude models from Model Garden and adds them to the Anthropic model picker.

Enable each Claude model in Model Garden before using it. Google may require accepting provider terms during activation.

See the [deployment environment variables](/docs/reference/configuration) for the full configuration.

### Workload Identity Federation (keyless)

Archestra can authenticate to the Anthropic API without a static API key using [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation): it exchanges a short-lived OIDC identity token from your identity provider (Kubernetes, AWS, GCP, Entra ID, GitHub Actions, and others) for an Anthropic access token and sends it as `Authorization: Bearer` upstream. Tokens are cached and refreshed automatically before expiry.

Configure a federation issuer, service account, and federation rule in the Claude Console (**Settings → Workload identity**), then set the `ARCHESTRA_ANTHROPIC_*` WIF environment variables — see [Environment Variables](/docs/reference/configuration) in the deployment docs. When configured, Archestra creates an "Anthropic Workload Identity Federation" system key automatically and syncs the available Claude models; users can also create Anthropic provider keys without entering an API key.

Note: the SDK-standard `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` environment variables take precedence over federation if present in the backend environment, matching Anthropic's documented credential precedence.
