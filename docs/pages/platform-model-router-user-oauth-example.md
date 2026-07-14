---
title: Model Router User OAuth
category: Examples
order: 1
description: Build a custom OAuth app that calls the OpenAI-compatible Model Router as the signed-in user
lastUpdated: 2026-07-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## Overview

This example shows a custom web application using OAuth authorization code with PKCE to call the OpenAI-compatible Model Router as the signed-in Archestra user.

Use this pattern when the app should inherit an individual user's LLM access. The app receives an OAuth access token with the `llm:proxy` scope, then uses that token as the Model Router bearer token.

The full example is available at [github.com/archestra-ai/examples/tree/main/model-router-user-oauth](https://github.com/archestra-ai/examples/tree/main/model-router-user-oauth).

## What the App Does

1. Dynamically registers a public OAuth client
2. Redirects the user to Archestra with `scope=llm:proxy`
3. Uses PKCE for the authorization-code exchange
4. Sends the OAuth access token to `/v1/model-router/{proxyId}/chat/completions`

This example does not use the registered clients under **Client Credentials > OAuth Clients** — those are confidential clients (a `client_id` with a secret). The example app registers a public client dynamically, and provider keys are resolved from the signed-in user's accessible Model Provider keys.

## Run the Example

```bash
git clone https://github.com/archestra-ai/examples
cd examples/model-router-user-oauth
cp .env.example .env
```

Set `LLM_PROXY_ID` in `.env`, then run:

```bash
npm install
npm run dev
```

Open [http://localhost:5174](http://localhost:5174), sign in with Archestra, approve the consent screen, and send a prompt.

## OAuth Routes Used

The example uses these Archestra OAuth routes:

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-authorization-server` | OAuth server metadata |
| `/api/auth/oauth2/register` | Dynamic public client registration |
| `/api/auth/oauth2/authorize` | Browser authorization and consent |
| `/api/auth/oauth2/token` | Authorization-code token exchange |

The authorization request includes:

```text
response_type=code
client_id=<registered client id>
redirect_uri=http://localhost:5174/oauth/callback
scope=llm:proxy offline_access
code_challenge=<PKCE challenge>
code_challenge_method=S256
state=<random state>
```

The token exchange includes:

```text
grant_type=authorization_code
client_id=<registered client id>
redirect_uri=http://localhost:5174/oauth/callback
code=<authorization code>
code_verifier=<PKCE verifier>
```

## Model Router Call

After token exchange, the app calls the OpenAI-compatible Model Router:

```bash
curl -X POST "http://localhost:9000/v1/model-router/{proxyId}/chat/completions" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai:gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

The requested model prefix determines which provider key is needed. For `openai:gpt-4o-mini`, the signed-in user must have access to an OpenAI Model Provider key.
