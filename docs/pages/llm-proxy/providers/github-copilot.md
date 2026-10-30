---
title: GitHub Copilot
description: Connect models from a personal GitHub Copilot seat or share an organization enterprise plan.
order: 7
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

GitHub Copilot gives you models from OpenAI, Anthropic, and Google, but GitHub does not provide standard API keys. Archestra bridges this gap so you can run Copilot models in chat, background agents, and local tools without managing raw keys.

Connect in one of two ways:

- **[Personal sign-in](#personal-sign-in):** sign in with your GitHub account to bring your own Copilot seat. The connection stays private to you.
- **[Enterprise plan](#enterprise-plans):** connect your organization's Copilot Business or Enterprise plan through a GitHub App. Your whole team and CI pipelines share models without buying individual seats for everyone.

Archestra handles the token exchange and refreshes credentials automatically.

![The Model Providers page showing GitHub Copilot under Personal subscriptions and Enterprise plans](/docs/automated_screenshots/platform-supported-llm-providers_model-providers.webp)

<span id="connecting-your-account"></span><span id="personal-sign-in-or-enterprise-plan"></span>

## Personal Sign-In

Bring your individual Copilot subscription into Archestra for personal chats, coding agents, and local tools.

On **Model Providers**, connect **GitHub Copilot** under **Personal subscriptions** and authorize Archestra on GitHub with the one-time device code.

Your sign-in belongs only to you and is never shared across your organization. If you set up the Copilot CLI with [Connect](/docs/get-started/connect), Archestra connects your account automatically.

## Enterprise Plans

Share your organization's Copilot Business or Enterprise models across teams, agents, and CI pipelines without purchasing per-user seats. Requests consume the organization's Copilot AI credits.

To connect a plan, your Archestra account needs permission to create provider keys and credentials ([`llmProviderApiKey:create`](/docs/reference/permissions#llmProviderApiKey:create) and [`credential:create`](/docs/reference/permissions#credential:create)).

<span id="connect-an-enterprise-plan"></span>

On **Model Providers**, connect **GitHub Copilot** under **Enterprise plans**. Create a new GitHub App or connect using existing App credentials. The App requires the **Copilot Requests (Read-only)** permission on your GitHub organization (see [App access to Copilot](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-app-copilot-access)). Install it on the organization, including one in an Enterprise Managed Users enterprise. An installation on the enterprise cannot make Copilot requests.

Once connected, Copilot models are available in Chat, agents, and the LLM proxy with a [virtual key](/docs/llm-proxy/authentication#standard-virtual-keys) (and on the [Model Router](/docs/llm-proxy/model-router) as `github-copilot:<model-id>`):

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
