---
title: GitHub Copilot
description: Use the models in your own GitHub Copilot subscription, or in your organization's Copilot plan through a GitHub App.
order: 7
lastUpdated: 2026-10-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Use the models your [GitHub Copilot](https://github.com/features/copilot) plan includes, such as GPT, Claude, and Gemini, with no API key to share. Connect it in one of two ways:

- **Personal sign-in:** each person signs in with their own GitHub account and their own Copilot seat.
- **Enterprise plan:** a GitHub App installed on your organization makes the requests, billed to the organization, and you choose who can use it.

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

## Enterprise Plans

Give a whole team Copilot models from your organization's plan, with no Copilot seat per person. A GitHub App installed on the organization makes every request, and the organization pays for it from its AI credits.

GitHub's App access to Copilot is in [public preview](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-organization/manage-app-copilot-access) and may change.

### Connect an Enterprise Plan

You need [`llmProviderApiKey:create`](/docs/reference/permissions#llmProviderApiKey:create) and [`credential:create`](/docs/reference/permissions#credential:create).

1. Go to **Model Providers**. Under **Enterprise plans**, click **Connect** on the **GitHub Copilot** card.
2. Enter the **Organization**. Change **GitHub URL** only for GitHub Enterprise Server. **Name** is optional.
3. Pick how to get the App:
   - **Use an App I already have:** a GitHub App already connected to Archestra.
   - **Create a new GitHub App:** GitHub creates it in a few clicks, then you install it on the organization. If you are not an owner, GitHub asks an owner to approve.
   - **Connect an App by its ID and private key:** an App that is not connected yet. Drop its `.pem` file; Archestra checks the key and shows its fingerprint.
4. On **Access**, choose who can use the plan, then click **Done**.

The card now shows **Connected**, and the plan's models appear under **GitHub Copilot**.

What to know:

- The App needs only the organization permission **Copilot Requests**, set to **Read-only**. Read-only still spends AI credits.
- GitHub cannot cap a single App. Set a limit in [Costs & Limits](/docs/llm-proxy/costs-and-limits), or turn on **Stop usage when budget limit is reached** in your GitHub billing settings.
- The App works only when installed on the organization, including one in an Enterprise Managed Users enterprise. A personal account or an installation on the enterprise cannot use it.

### Manage or Reconnect a Plan

**Manage** on the card opens the same steps for the connected plan. Switch to another App, rotate the App's private key with **Connect an App by its ID and private key**, or change who can use it. When GitHub refuses the App, for example after it was uninstalled or its key was revoked, the card shows **Reconnect**. Switching to another App leaves the old App connected to Archestra, because other features may use it.

### Personal Sign-In or Enterprise Plan

| | Personal sign-in | Enterprise plan |
| --- | --- | --- |
| Who pays | Each person's Copilot seat | The organization's AI credits |
| Who can use it | Only the person who signed in | Anyone you grant on **Access** |
| Who sets it up | Each person | Someone who can create provider keys and credentials |

## Limits

- **No static API keys**: access is per-user via a GitHub OAuth token; model availability follows that account's Copilot subscription tier.
- **Personal sign-in is per-user**: because the token is tied to one GitHub account, a personal Copilot key is always **just for you** — it can't be a shared key or sit in a virtual key anyone else can use. Each user connects their own account. Your own virtual key may map Copilot alongside other providers, which is what makes it routable through the model router. When someone uses an agent with a Copilot model but hasn't connected yet, Archestra resolves *their* key (never the agent owner's) and prompts them to connect: an inline "Connect GitHub Copilot" card in chat, or a message with a Settings link in Slack/Teams. Email and scheduled runs fail with an actionable message.
- **Generative models only**: the `/models` listing covers every model reachable through `/chat/completions` or `/responses`. Copilot also serves an Anthropic `/v1/messages` shim and embedding models, which Archestra does not route to.
- **GitHub Enterprise**: point the base, token-exchange, and device-auth URLs at your GHE host. Organizations with their own GitHub App can override the client id.
- **Enterprise plan models**: the plan lists the models GitHub offers to the App, which can be fewer than a personal seat gets. If Claude or Gemini models are missing, check your organization's Copilot model policy on GitHub.
