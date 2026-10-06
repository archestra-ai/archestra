---
title: Apps and Services
description: Let your own app or service call an MCP Gateway with an OAuth client
order: 2
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give your app its own identity in Archestra, not a person's token. A support bot, a nightly job, or an internal portal gets an OAuth client. You choose the gateways and agents it reaches. Its tokens expire, and you can rotate its secret at any time.

Pick the **Grant type** by who is behind each call:

| Grant type | Each call acts as | Example |
| --- | --- | --- |
| **[Application](#oauth-client-credentials-applications)** (client credentials) | The app itself | A bot that triages tickets every night |
| **[On behalf of users](#oauth-authorization-code-on-behalf-of-users)** (authorization code) | The person signed in to your app | An internal portal where people ask an agent questions |

Create either one under **Settings → OAuth Clients → Create OAuth Client**, or from a gateway's **Connect** tab.

<span id="oauth-client-credentials-applications"></span>

## Call as the App

No person signs in, so the app uses the gateway's shared accounts. Give its tools a shared service account in [Choose Its Tools](/docs/mcp/gateway#choose-its-tools).

1. Create an OAuth client. Pick **Application** as the **Grant type**, and the gateways and agents it may reach.
2. Save the client ID and secret in your secret store. The secret shows only once.
3. Get a token:

   ```bash
   curl --request POST "$ARCHESTRA_URL/api/auth/oauth2/token" \
     --data-urlencode 'grant_type=client_credentials' \
     --data-urlencode "client_id=$CLIENT_ID" \
     --data-urlencode "client_secret=$CLIENT_SECRET" \
     --data-urlencode 'scope=mcp'
   ```

4. Call the gateway with `Authorization: Bearer <access_token>`. Get a new token when it expires.

<span id="oauth-authorization-code-on-behalf-of-users"></span>

## Call for a Person

Each call acts as the person signed in to your app, with their own tools and accounts. A ticket the agent files shows their name, not the app's.

1. Create an OAuth client. Pick **On behalf of users** as the **Grant type**, and add your app's redirect URIs.
2. In your app, run the authorization code flow with PKCE and the client secret. Ask for `scope=mcp`. Add `offline_access` to get a refresh token.
3. Call the gateway with the person's access token.

Leave **Allowed gateways & agents** empty to use each person's own access. If you pick some, everyone who signs in through your app can reach them, even without their own access.

## What to Know

- Secret leaked? Open the client and click **Rotate secret**. The old secret stops working.
- The same clients can call the LLM Proxy. Pick **LLM Proxy** under **What will this client access?**. See [LLM Proxy authentication](/docs/llm-proxy/authentication).
