---
title: Authentication
category: LLM Proxy
order: 3
description: Authentication methods for the LLM Proxy
lastUpdated: 2026-05-04
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The LLM Proxy supports direct provider API keys, virtual API keys, OAuth access tokens, and JWKS via an external identity provider.

| Method | Best for | Model Router | Notes |
| --- | --- | --- | --- |
| Direct provider key | Simple provider-specific proxy calls | No | Sends the raw provider key with each request. |
| Virtual API key | Provider-specific LLM clients, generic Model Router clients, and individual developers | Yes | Works as a provider key replacement on provider-specific proxy routes, or as the `apiKey` for Model Router clients. |
| LLM OAuth client access token | Backend services, production apps, and external bots | Yes | Uses OAuth client credentials to issue short-lived bearer tokens. |
| User OAuth access token | Custom apps acting for an individual user | Yes | Uses the authorization code flow with consent and the `llm:proxy` scope. |
| JWKS | Enterprise IdP JWT callers | Provider routes | Resolves a user from an external IdP JWT. |

## Direct Provider API Key

Pass your raw provider API key in the standard authorization header. The proxy forwards it to the upstream provider.

```bash
# OpenAI example
curl -X POST "https://archestra.example.com/v1/openai/{proxyId}/chat/completions" \
  -H "Authorization: Bearer sk-your-openai-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

This is the simplest approach but means the real provider key is sent with every request from your client application.

## Virtual API Keys

Virtual API keys are platform-managed bearer tokens that map to one or more provider API keys stored in Archestra. The real provider keys never leave Archestra.

### Benefits

- **Key isolation**: Provider keys stay in Archestra; clients only see the virtual token
- **Revocable**: Delete a virtual key without rotating the underlying provider key
- **Expirable**: Set an optional expiration date
- **Per-key base URL**: The underlying provider key can have a custom base URL (e.g., for proxies or self-hosted endpoints)

### Creating Virtual Keys

1. Go to **LLM Proxies > Credentials > Virtual Keys**
2. Create a virtual key
3. Map at least one provider API key
4. Copy the generated token (shown only once)

### Using Virtual Keys

Use the virtual key in place of the provider key:

```bash
curl -X POST "https://archestra.example.com/v1/openai/{proxyId}/chat/completions" \
  -H "Authorization: Bearer arch_abc123def456..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

The proxy resolves the virtual key to the mapped provider key and base URL, then forwards the request.

### Provider Matching

Each virtual key can map one key per provider. Provider-specific proxy routes use the mapped key for that route provider. For example, an OpenAI route requires an OpenAI mapping.

### Model Router Virtual Keys

Model Router routes require a virtual key with at least one provider key mapping. Direct provider API keys are rejected on `/v1/model-router/*`.

The `/models` endpoint returns models only for mapped providers, and `/responses` or `/chat/completions` can only route to those providers.

Use the same virtual key against the Model Router base URL:

```bash
curl -X POST "https://archestra.example.com/v1/model-router/{proxyId}/responses" \
  -H "Authorization: Bearer arch_abc123def456..." \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic:claude-haiku-4-5-20251001", "input": "Hello"}'
```

## LLM OAuth Clients

LLM OAuth clients are registered clients that call LLM proxy endpoints with OAuth client credentials. Use them for backend services, production apps, automation jobs, and external bots. The OAuth client receives a `client_id` and one-time `client_secret`, exchanges them for a fixed 1-hour access token, and uses that token as the proxy bearer token.

Virtual keys are still the recommended path for generic LLM clients that cannot fetch OAuth tokens. LLM OAuth clients are better when you control the service code and can request a token before calling an LLM proxy. See [Model Router Client Credentials](/docs/platform-model-router-client-credentials-example) for a complete service-app example.

### Managing OAuth Clients

1. Go to **LLM Proxies > Credentials > OAuth Clients**
2. Create an OAuth client
3. Select the LLM proxies it can access
4. Map the provider API keys it can use
5. Copy the generated `client_id` and `client_secret` (the secret is shown only once)

You can edit an OAuth client later to update its name, allowed LLM proxies, or provider key mappings. Rotate the client secret when the existing secret needs to be replaced.

### Getting an Access Token

```bash
curl -X POST "https://archestra.example.com/api/auth/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "scope=llm:proxy"
```

### Calling Provider-Specific Routes

```bash
curl -X POST "https://archestra.example.com/v1/openai/{proxyId}/chat/completions" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

For provider-specific routes, the OAuth client must have a provider key mapping that matches the route provider.

### Calling the Model Router

```bash
curl -X POST "https://archestra.example.com/v1/model-router/{proxyId}/responses" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "openai:gpt-5.4", "input": "Hello"}'
```

For Model Router routes, the OAuth client must have a provider key mapping for the provider prefix in the requested model.

LLM logs and traces record the authenticated OAuth client separately from `X-Archestra-Agent-Id`. Use `X-Archestra-Agent-Id` as a caller-provided label, not as proof of client identity.

### User OAuth Apps

Custom applications can also use the OAuth authorization code flow when they act on behalf of an individual user. The application redirects the user to the authorization endpoint with the `llm:proxy` scope, the user approves the consent screen, and the application exchanges the code for a user access token.

User OAuth tokens do not use the LLM OAuth Clients page. Provider-specific routes and Model Router resolve provider keys from the authorized user's accessible Model Provider keys: personal keys, org-wide keys, and team keys for teams the user belongs to.

The user OAuth token lifetime is controlled by **Settings > Organization > Auth > OAuth token lifetime**. The same setting applies to newly issued user OAuth tokens for MCP and custom application authorization-code flows. It does not change the fixed 1-hour lifetime for LLM OAuth client credentials tokens.

Use this approach when the application should inherit an individual user's access. Use LLM OAuth client credentials when the caller is a backend service or automation job with its own app identity. See [Model Router User OAuth](/docs/platform-model-router-user-oauth-example) for a complete example application.

## JWKS (External Identity Provider)

Link an Identity Provider (IdP) to the LLM Proxy so clients can authenticate with JWTs issued by your IdP. The proxy validates the JWT signature via the IdP's JWKS endpoint and resolves the actual LLM provider API key from the matched Archestra user's configured keys.

### How it works

1. Client sends `Authorization: Bearer <jwt>` to the LLM Proxy
2. Proxy validates the JWT against the LLM Proxy's linked IdP's JWKS endpoint
3. The JWT `email` claim is matched to an Archestra user
4. The provider API key is resolved from that user's (or org's) configured LLM API keys
5. The request is forwarded to the upstream LLM provider with the resolved key

### Setup

1. Go to **Settings > Identity Providers** and create an OIDC provider (issuer URL, client ID, client secret)
2. Open the LLM Proxy profile and select the identity provider in the **Identity Provider** dropdown
3. Clients authenticate with JWTs from the configured IdP

```bash
# Get a JWT from your IdP (example: Keycloak direct grant)
JWT=$(curl -s -X POST "https://keycloak.example.com/realms/myrealm/protocol/openid-connect/token" \
  -d "grant_type=password&client_id=my-client&client_secret=secret&username=user&password=pass&scope=openid" \
  | jq -r .access_token)

# Call the LLM Proxy with the JWT
curl -X POST "https://archestra.example.com/v1/openai/{proxyId}/chat/completions" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

## API Key Scoping

Each LLM API key has a **scope** that controls who can use it:

- **Personal** — Only visible to and usable by the user who created it.
- **Team** — Available to all members of the selected team.
- **Organization** — Available to all members of the organization. Admin-only.

You can create **multiple keys per provider per scope** (e.g. two personal Anthropic keys with different base URLs). Mark one key as **Primary** to control which key is preferred when resolving. If no key is marked primary, the oldest key is used.

When the Archestra Chat, JWKS auth, or user OAuth Model Router auth resolves a provider key, it follows this priority: personal key > team key > organization-wide key > environment variable. If multiple keys exist in the same scope for a provider, the primary key is selected first; otherwise, the oldest key is selected.

## Custom Base URLs

Each LLM API key can have an optional **Base URL** that overrides the [environment-variable default](/docs/platform-deployment#llm-provider-configuration). This is configured when creating or editing an API key in Provider Settings.

Use cases:
- Self-hosted Ollama at a non-default address
- OpenAI-compatible proxies
- Regional endpoints

When a virtual key or OAuth client access token is resolved, the mapped provider key's base URL is used automatically.
