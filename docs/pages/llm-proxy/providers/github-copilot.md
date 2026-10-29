---
title: GitHub Copilot
description: Use models from your personal GitHub Copilot subscription or your organization's enterprise plan.
order: 7
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use models from your personal GitHub Copilot subscription, or connect your GitHub organization's Copilot Business or Enterprise plan.

![The Model Providers page showing GitHub Copilot under Personal subscriptions and Enterprise plans](/docs/automated_screenshots/platform-supported-llm-providers_model-providers.webp)

<span id="connecting-your-account"></span><span id="personal-sign-in-or-enterprise-plan"></span>

## Personal Sign-In

Use your personal GitHub Copilot seat in Chat, agents, and local tools.

On **Model Providers**, connect **GitHub Copilot** under **Personal subscriptions** and authorize Archestra on GitHub with the one-time device code.

Personal sign-ins belong only to the person who connected them and are never shared. You can also connect automatically via [Connect](/docs/get-started/connect) when setting up the Copilot CLI.

<span id="enterprise-plans"></span>

## Enterprise Plans

Use your organization's Copilot plan without buying per-user seats. Requests are billed to the organization's Copilot AI credits.

To connect a plan, your Archestra user account needs permission to create provider keys and credentials (llmProviderApiKey:create and credential:create). On GitHub, your organization must have [App access to Copilot](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-app-copilot-access) enabled.

<span id="connect-an-enterprise-plan"></span>

Create a new GitHub App or connect using existing App credentials. The App requires the **Copilot Requests (Read-only)** permission on your GitHub organization.

Once connected, use the organization's Copilot models in Chat, agents, or through the proxy with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) (and on the [Model Router](/docs/llm-proxy/model-router) as `github-copilot:<model-id>`):

```bash
curl "https://<archestra-host>/v1/github-copilot/chat/completions" \
  -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4.1",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

<span id="manage-or-reconnect-a-plan"></span><span id="proxy-endpoint"></span><span id="limits"></span>
