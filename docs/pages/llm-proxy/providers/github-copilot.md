---
title: GitHub Copilot
description: Connect the models included in your own GitHub Copilot subscription.
order: 7
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use the models your [GitHub Copilot](https://github.com/features/copilot) plan includes, such as GPT, Claude, and Gemini. Each person signs in with their own GitHub account. There is no API key to share.

## Proxy Endpoint

- **Base URL**: `https://<archestra-host>/v1/github-copilot`
- **Authentication**: Pass your **GitHub OAuth token** (the credential below) in the `Authorization` header as `Bearer <token>`

Copilot models are also reachable through the model router as `github-copilot:<model-id>`. See [Model Router](/docs/llm-proxy/model-router).

## Connecting Your Account

A GitHub Copilot provider key stores a **long-lived GitHub OAuth token** (`gho_`/`ghu_…`) for an account with an active Copilot subscription — not a Copilot API key, which does not exist. Archestra exchanges that token for a short-lived Copilot bearer on every request (cached and refreshed automatically), so clients only ever present the GitHub token.

Archestra uses the account API endpoint returned by GitHub, falling back to `https://api.githubcopilot.com` when absent. A custom base URL takes precedence.

Obtain the token in either way:

- **Sign in with GitHub**: click **Connect** on the **GitHub Copilot** card on **Model Providers**. It runs GitHub's OAuth device flow — you approve a one-time code at `github.com/login/device`, and Archestra stores the resulting token.
- **Reuse an existing token**: the official Copilot CLI / VS Code store one in `~/.config/github-copilot/apps.json` (the `oauth_token` value); paste it into the API key field. The `/connection` setup script for the Copilot CLI reuses or obtains this token automatically.

## Limits

- **No static API keys**: access is per-user via a GitHub OAuth token; model availability follows that account's Copilot subscription tier.
- **Per-user only**: because the token is tied to one GitHub account, a Copilot key is always **just for you** — it can't be a shared key or sit in a virtual key anyone else can use. Each user connects their own account. Your own virtual key may map Copilot alongside other providers, which is what makes it routable through the model router. When someone uses an agent with a Copilot model but hasn't connected yet, Archestra resolves *their* key (never the agent owner's) and prompts them to connect: an inline "Connect GitHub Copilot" card in chat, or a message with a Settings link in Slack/Teams. Email and scheduled runs fail with an actionable message.
- **Generative models only**: the `/models` listing covers every model reachable through `/chat/completions` or `/responses`. Copilot also serves an Anthropic `/v1/messages` shim and embedding models, which Archestra does not route to.
- **GitHub Enterprise**: point the base, token-exchange, and device-auth URLs at your GHE host. Organizations with their own GitHub App can override the client id.
