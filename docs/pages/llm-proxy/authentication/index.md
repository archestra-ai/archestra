---
title: LLM Proxy Authentication
sidebarTitle: Authentication
description: How apps, agents, and people sign in to the LLM Proxy, and whose provider key each call uses
order: 1
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

First, add your provider keys on [Model Providers](/docs/llm-proxy/providers). They stay in Archestra. Then pick how each app or person signs in to the proxy, by what your client supports:

| Your client | Use | Model Router |
| --- | --- | --- |
| An app | [Standard virtual key](#standard-virtual-keys) | Yes |
| A tool with its own key or subscription, like Claude Code | [Passthrough virtual key](#passthrough-virtual-keys) | No |
| A service that gets OAuth tokens | [OAuth, as the app](#call-as-the-app) | Yes |
| An app where people sign in | [OAuth, for each person](#call-for-a-person) | Yes |
| A token from your identity provider | [Identity provider JWT](#jwks-external-identity-provider) | No |

<span id="creating-standard-virtual-keys"></span><span id="standard-virtual-keys-on-the-model-router"></span>

## Standard Virtual Keys

Give each app its own key. To cut off one app, delete its key. Other apps keep working.

1. Go to **LLM Proxy** and click **Create standard virtual key**.
2. Name it. Every provider starts with its primary key. Change a key or remove a provider if the app needs less.
3. Optionally pick who pays for it, who can access it, and when it expires. Then create it.
4. Copy the key. It shows only once. The dialog then shows a request with your key filled in.
5. Use the key wherever the app expects a provider API key:

   ```bash
   curl "https://<archestra-host>/v1/openai/chat/completions" \
     -H "Authorization: Bearer $ARCHESTRA_VIRTUAL_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
   ```

The request shows under **Logs → LLM Proxy**, with the key's name.

<span id="provider-matching"></span>

- With **Selected providers**, the key needs a mapping for the route's provider. An OpenAI route needs an OpenAI key. On the [Model Router](/docs/llm-proxy/model-router), the model's prefix picks the mapping.
- Self-hosted providers can map several endpoints. Archestra sends each request to the endpoint that serves the model. You can edit a virtual key to add providers or endpoints without changing its token.
- Choose **Current and future providers** to automatically use each provider's shared **Primary** API key, including providers added later. Personal and subscription keys are excluded. You can optionally select a different key for an existing provider. Connect settings apply this option to newly issued keys.
- **To share a key** with a team, add the team under its permissions, when you create the key or later.
- To bill a team, pick it as the payer. The key's spend then counts toward that team's [costs](/docs/llm-proxy/costs-and-limits#track-spending) and [limits](/docs/llm-proxy/costs-and-limits#set-a-budget), not its creator's. A spend cap there limits the key itself.

<span id="creating-passthrough-virtual-keys"></span><span id="configuring-claude-code-and-claude-desktop"></span>

## Passthrough Virtual Keys

Use your own subscription or key, and still show up in costs and logs. Claude Code on a Claude subscription is the common case.

[Connect](/docs/get-started/connect) sets this up for Claude Code, Claude Desktop, Codex, OpenCode, and Kilo Code. For any other client:

1. Go to **LLM Proxy** and click **Create passthrough virtual key**. Copy the key.
2. Send it in `X-Archestra-Virtual-Key`, next to the provider's own credential:

   ```bash
   curl "https://<archestra-host>/v1/openai/chat/completions" \
     -H "Authorization: Bearer $OPENAI_API_KEY" \
     -H "X-Archestra-Virtual-Key: $ARCHESTRA_PASSTHROUGH_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
   ```

- The passthrough key only says who you are. It gives no access to Archestra's provider keys.
- It belongs to one person.
- <span id="direct-provider-api-key"></span>Without it, the call still works, but the logs cannot name you.

<span id="llm-oauth-clients"></span><span id="managing-oauth-clients"></span>

## OAuth Clients

Use OAuth when your app should get short-lived tokens, not a key that never expires.

Go to **Settings → OAuth Clients → Create OAuth Client**, and select **LLM Proxy** under **What can it access?**. Select **MCP Gateway** or **A2A** as well if the application also needs tools or agents. One client ID and secret covers the selected APIs. Then pick how it signs in:

<span id="getting-an-access-token"></span>

### Call as the App

For a bot or a nightly job with no person behind it. Select **Service account (optional)** under **Access → Advanced** to use that account’s permissions and attribute LLM spend to it. Enable **MCP Gateway** or **A2A** on the same client for [shared A2A run ownership](/docs/mcp/authentication/applications#call-as-the-app).

1. Pick **As itself**. On **Access**, choose **Selected providers** to fix the allowed providers and keys, or **Current and future providers** to follow shared Primary keys automatically. If you enabled tools or agents, select their gateways and agents too.
2. Under **Advanced → Budget** on the same step, optionally pick the team that pays for it or set a spend cap.
3. Save the client ID and secret. The secret shows only once.
4. Get a token. It lasts one hour.

   ```bash
   curl --request POST "https://<archestra-host>/api/auth/oauth2/token" \
     --data-urlencode 'grant_type=client_credentials' \
     --data-urlencode "client_id=$CLIENT_ID" \
     --data-urlencode "client_secret=$CLIENT_SECRET" \
     --data-urlencode 'scope=llm:proxy'
   ```

5. Send `Authorization: Bearer <access_token>` on a provider route or the Model Router.

- When editing a client, use **Access** to change capabilities and provider keys, and **Budget** to change its payer or spend cap.
- The billing team's [costs](/docs/llm-proxy/costs-and-limits#track-spending) and [limits](/docs/llm-proxy/costs-and-limits#set-a-budget) count the client's spend. A spend cap limits the client itself.
- **Current and future providers** uses shared **Primary** keys at request time, including later providers and changes to the Primary key. Personal and subscription keys are excluded. Under **LLM API keys**, you can override the key for a provider. Enabling this mode requires a [**Can use** grant](/docs/admin/access-control#granular-access-control) on all current and future provider keys (`*`); access to each current key separately is insufficient.
- Existing OAuth clients keep **Selected providers** until you change their mode.
- Map a metered API key. A personal subscription cannot serve an app.
- See the [complete example app](https://github.com/archestra-ai/examples/tree/main/model-router-client-credentials).

For a combined client, request a space-separated subset such as `scope=llm:proxy mcp`. See [token scopes](/docs/mcp/authentication/applications#choose-token-scopes) for scope selection and changes to an existing client.

<span id="on-behalf-of-users-authorization-code"></span>

### Call for a Person

For an app where people sign in. Each call uses that person's provider keys, cost limits, and policies.

1. Pick **For its users**. On **Access**, add your app's redirect URIs. Each person pays for their own use. An optional spend cap limits the whole client.
2. In your app, run the authorization code flow with PKCE. Ask for `scope=llm:proxy`. Add `offline_access` to get a refresh token.
3. Send the person's access token on a provider route or the Model Router.

- A public app can register itself, with no secret. To allow only clients you register, set [`ARCHESTRA_AUTH_DCR_ENABLED=false`](/docs/reference/configuration#ARCHESTRA_AUTH_DCR_ENABLED).
- Set how long tokens last under **Settings → Auth → OAuth token lifetime**.
- See the [complete example app](https://github.com/archestra-ai/examples/tree/main/model-router-user-oauth).

<span id="jwks-external-identity-provider"></span>

## Identity Provider JWT

Already signed in to Okta or Entra ID? Send that token. Each call uses that person's provider keys. Identity providers are an Enterprise feature. See [Pricing Model](/docs/get-started/pricing-model).

1. Add your OIDC provider under **Settings → Identity Providers**.
2. On **LLM Proxy**, under **Identity provider**, pick it. You need [`llmProxy:update`](/docs/reference/permissions#llmProxy:update).
3. Send the JWT as `Authorization: Bearer` on a provider route. The Model Router does not take it.

Archestra checks the signature and issuer, then matches the email claim to an Archestra user. If either fails, the request is rejected.

<span id="attribution-in-logs"></span><span id="api-key-scoping"></span><span id="custom-base-urls"></span>

## What to Know

- **Logs name a person** only for a personal virtual key, a passthrough key, user OAuth, or an identity provider JWT. A shared key names the key, and an app's token names the app. Give each budget its own credential.
- Which provider key a call uses and per-key **Base URL** settings are on [Model Providers](/docs/llm-proxy/providers#which-key-a-request-uses).
