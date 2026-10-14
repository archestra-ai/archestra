---
title: Gateway Access for Apps
sidebarTitle: Apps and Services
description: Let your own app or service call an MCP Gateway with an OAuth client
order: 2
lastUpdated: 2026-10-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give your app its own identity in Archestra, not a person's token. A support bot, a nightly job, or an internal portal gets an OAuth client. You choose the gateways and agents it reaches. Its tokens expire, and you can rotate its secret at any time.

Pick how it signs in by who is behind each call:

| How it signs in | Each call acts as | Example |
| --- | --- | --- |
| **[As itself](#oauth-client-credentials-applications)** (client credentials) | The app or a selected service account | A bot that triages tickets every night |
| **[For its users](#oauth-authorization-code-on-behalf-of-users)** (authorization code) | The person signed in to your app | An internal portal where people ask an agent questions |

Create either one under **Settings → OAuth Clients → Create OAuth Client**, or from a gateway's **Connect** tab.

<span id="oauth-client-credentials-applications"></span>

## Call as the App

Each application owns its A2A tasks and retained runtime workspaces. Use the same application's credentials to list, read, follow, or cancel its tasks; tokens renewed for that application retain access. A different application cannot access those tasks, even when both can call the same agent.

Select **Service account (optional)** on the create dialog's **Access** step to give an automation one identity across OAuth and REST API keys. Its A2A tasks and runtime workspaces belong to that account: OAuth credentials and API keys for the same account can read, follow, or cancel those tasks. Other accounts cannot access them. Use the account's API key on the platform API to manage its runs and delete its own retained workspaces.

The client's allowed agents and gateways still limit OAuth access, and the service account must also have permission to use each resource. Disabling the account stops its OAuth requests; changing the binding revokes issued OAuth tokens. In the edit dialog, the selector is under **Access**.

For LLM Proxy access, enable **LLM Proxy** on the same client and select provider keys on **Access**. Its service-account binding covers all enabled APIs. Spend from that client and runtime virtual keys is attributed to the account. Binding does not supply upstream credentials.

No person signs in, so the app uses the gateway's shared accounts. Give its tools a shared service account in [Choose Its Tools](/docs/mcp/gateway#choose-its-tools).

1. Create an OAuth client. Under **What can it access?**, select **MCP Gateway** for tools, **A2A** for agent calls, or both. Pick **As itself**. On **Access**, select the gateways and agents it may reach and optionally select a service account.
2. Save the client ID and secret in your secret store. The secret shows only once.
3. Get a token. This example calls MCP; use `scope=a2a` for agent calls:

   ```bash
   curl --request POST "$ARCHESTRA_URL/api/auth/oauth2/token" \
     --data-urlencode 'grant_type=client_credentials' \
     --data-urlencode "client_id=$CLIENT_ID" \
     --data-urlencode "client_secret=$CLIENT_SECRET" \
     --data-urlencode 'scope=mcp'
   ```

4. Call the gateway with `Authorization: Bearer <access_token>`. Get a new token when it expires.

Reuse each token until it expires. If the token endpoint returns HTTP `429`, wait for its `Retry-After` delay before requesting another token. See [authentication rate limits](/docs/reference/configuration#ARCHESTRA_AUTH_RATE_LIMIT_DISABLED).

<span id="oauth-authorization-code-on-behalf-of-users"></span>

## Call for a Person

Each call acts as the person signed in to your app, with their own tools and accounts. A ticket the agent files shows their name, not the app's.

1. Create an OAuth client. Select its capabilities and **For its users**. On **Access**, add your app's redirect URIs.
2. In your app, run the authorization code flow with PKCE and the client secret. Ask for `scope=mcp` for tools or `scope=a2a` for agent calls. Add `offline_access` to get a refresh token.
3. Call the gateway with the person's access token.

On **Access**, leave **Additional gateways and agents (optional)** empty to use each person's own access. Selecting resources adds access for everyone who signs in through your app, even without their own access.

## Choose Token Scopes

Ask for only the enabled capabilities each token needs:

| Scope | API |
| --- | --- |
| `mcp` | MCP Gateway |
| `a2a` | Agent A2A endpoints |
| `llm:proxy` | LLM Proxy and Model Router |

For example, `scope=mcp llm:proxy` gets one token for tools and inference. Each requested scope must be enabled on the client. Omitting `scope` in a client credentials request grants all its configured capabilities. A token cannot gain a capability added after it was issued; request a new token. Removing a capability or disabling the client blocks its use immediately.

Open an existing client and use **Access** to change its capabilities, gateways, agents, or provider keys. The client ID and secret stay the same.

## What to Know

- Secret leaked? Open the client and click **Rotate secret**. The old secret stops working.
- An application can use the same client ID and secret for several APIs. Select **LLM Proxy** as well, then configure its provider keys. See [LLM Proxy authentication](/docs/llm-proxy/authentication).
