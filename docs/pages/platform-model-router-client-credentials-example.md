---
title: Model Router Client Credentials
category: Examples
order: 2
description: Build a service app that calls the OpenAI-compatible Model Router with OAuth client credentials
lastUpdated: 2026-05-04
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

## Overview

This example shows a backend service using OAuth client credentials to call the OpenAI-compatible Model Router.

Use this pattern for services, automation jobs, bots, and server-side applications that should authenticate as an app. The app receives a short-lived OAuth access token with the `llm:proxy` scope, then uses that token as the Model Router bearer token.

The full example is available at [github.com/archestra-ai/examples/tree/main/model-router-client-credentials](https://github.com/archestra-ai/examples/tree/main/model-router-client-credentials).

## What the App Does

1. Uses an OAuth client created in **LLM Proxies > Credentials > OAuth Clients**
2. Exchanges `client_id` and `client_secret` for an access token
3. Sends the access token to `/v1/model-router/{proxyId}/chat/completions`

OAuth client credentials do not use a browser consent screen and do not inherit a user's Model Provider keys. Provider access comes from the OAuth client's provider key mappings.

## Run the Example

Create an OAuth client in **LLM Proxies > Credentials > OAuth Clients**. Select the LLM proxy it can access, map the provider keys it can use, and copy the generated secret.

Then run:

```bash
git clone https://github.com/archestra-ai/examples
cd examples/model-router-client-credentials
cp .env.example .env
```

Set these values in `.env`:

```text
LLM_PROXY_ID=<your LLM proxy id>
OAUTH_CLIENT_ID=<client id>
OAUTH_CLIENT_SECRET=<client secret>
MODEL=openai:gpt-4o-mini
```

Install dependencies and run:

```bash
npm install
npm start
```

## OAuth Routes Used

The example uses these Archestra OAuth routes:

| Route | Purpose |
| --- | --- |
| `/.well-known/oauth-authorization-server` | OAuth server metadata |
| `/api/auth/oauth2/token` | Client-credentials token exchange |

The token exchange includes:

```text
grant_type=client_credentials
client_id=<client id>
client_secret=<client secret>
scope=llm:proxy
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

The requested model prefix determines which provider mapping is needed on the OAuth client.
