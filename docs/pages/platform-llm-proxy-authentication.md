---
title: Authentication
category: LLM Proxy
order: 3
description: Authentication methods for the LLM Proxy
lastUpdated: 2026-07-03
---

The LLM Proxy supports direct provider API keys, virtual API keys, passthrough virtual keys, OAuth access tokens, and JWKS via an external identity provider.

| Method | Best for | Model Router | Notes |
| --- | --- | --- | --- |
| Direct provider key | Simple provider-specific proxy calls | No | Sends the raw provider key with each request. |
| Virtual API key | Provider-specific LLM clients, generic Model Router clients, and individual developers | Yes | Works as a provider key replacement on provider-specific proxy routes, or as the `apiKey` for Model Router clients. |
| Passthrough virtual key | Authenticating proxy user while passing provider credentials through (e.g. a Claude Code subscription) | N/A | Sent in the `X-Archestra-Virtual-Key` header alongside another credential; carries no provider key of its own. |
| LLM OAuth client access token | Backend services, production apps, and external bots | Yes | OAuth `client_credentials` grant; the client brings its own provider keys. |
| User OAuth access token | Apps acting for an individual user | Yes | Authorization code flow with the `llm:proxy` scope; the app can self-register or be pre-registered (confidential) on the OAuth Clients page. Resolves the user's own provider keys. |
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

Virtual API keys are platform-managed bearer tokens that map to one or more provider API keys stored in Archestra. The real provider keys never leave Archestra — clients only see the virtual token. You can delete a virtual key without rotating the underlying provider key, and set an optional expiration date on it. Each underlying provider key can have a custom base URL, for a proxy or self-hosted endpoint.

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

## Passthrough Virtual Keys

Passthrough virtual keys authenticates an Archestra user to LLM Proxy. They cover the case where a client passes a provider or subscription token straight through — for example, Claude Code forwarding a Claude Max subscription token. The proxy forwards that token upstream, while the passthrough key tells Archestra which user made the call.

Unlike the unauthenticated `X-Archestra-User-Id` header, a passthrough key is a secret bound to a user, so the attribution is authenticated. This lets you attribute and access-control requests per user even when the provider credential is opaque.

### Properties

- **Personal only**: a passthrough key belongs to one user. Admins can create one on behalf of another member; non-admins only for themselves.
- **No provider keys**: it never maps a provider API key and cannot be used as a provider credential in the `Authorization` header.
- **Expirable**: set an optional expiration like any virtual key.

### Creating Passthrough Virtual Keys

1. Go to **LLM Proxies > Credentials > Virtual Keys**
2. Create a virtual key and choose the **Passthrough** type
3. As an admin, optionally pick the owner
4. Copy the generated token (shown only once)

### Using

Send the passthrough key in the `X-Archestra-Virtual-Key` header, alongside whatever credential authenticates the upstream provider call:

```bash
curl -X POST "https://archestra.example.com/v1/anthropic/{proxyId}/v1/messages" \
  -H "Authorization: Bearer sk-ant-your-subscription-token" \
  -H "X-Archestra-Virtual-Key: arch_abc123def456..." \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-haiku-4-5-20251001", "max_tokens": 64, "messages": [{"role": "user", "content": "Hello"}]}'
```

A valid passthrough key authenticates the user at the proxy, but it does not by itself satisfy the upstream provider — that still needs its own credential.

### Configuring Claude Code and Claude Desktop

The in-app Connection page wires this header up per platform (macOS, Linux, Windows). For Claude Code passthrough — a Claude subscription on the Anthropic provider, or your own AWS credentials on the Bedrock provider — the one-command setup provisions a passthrough key and merges it into `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://archestra.example.com/v1/anthropic/{proxyId}",
    "ANTHROPIC_CUSTOM_HEADERS": "X-Archestra-Agent-Id: anthropic_claude_code\nX-Archestra-Virtual-Key: arch_abc123def456..."
  }
}
```

`ANTHROPIC_CUSTOM_HEADERS` takes `Name: Value` pairs (newline-separated for several) and applies to the Bedrock transport too, so the same headers attribute requests routed through a Bedrock proxy. Leave `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` unset so the Claude subscription still authenticates the upstream call — the header only authenticates an Archestra user on an LLM Proxy.

The setup always adds `X-Archestra-Agent-Id` too — a non-secret client identifier (`anthropic_claude_code` for Claude Code, `anthropic_claude_desktop` for Claude Desktop) that attributes each proxied request to the client app in the LLM logs. It rides alongside the passthrough key but is independent of it, so it is present even when no passthrough key is provisioned.

Claude Desktop can be configured by hand: open **Developer > Configure Third-Party Inference**, fill in the API key and base URL, then add two custom headers — `X-Archestra-Agent-Id` set to `anthropic_claude_desktop`, and `X-Archestra-Virtual-Key` set to the passthrough key.

The connection page also generates an importable configuration profile file for Claude Desktop. Download it, then in **Configure Third-Party Inference** open the **Default** dropdown (top right) and choose **Import configuration…** to load it. Click **Apply Changes** and restart Claude Desktop to pick up the new configuration.

## LLM OAuth Clients

LLM OAuth clients are clients you register to call LLM proxy endpoints. They support two grants: **client credentials** (an application acting as itself, covered here) and **authorization code** (a pre-registered app acting on behalf of a signed-in user — see [On Behalf of Users](#on-behalf-of-users-authorization-code)).

With the `client_credentials` grant, use them for backend services, production apps, automation jobs, and external bots. The OAuth client receives a `client_id` and one-time `client_secret`, exchanges them for a fixed 1-hour access token, and uses that token as the proxy bearer token.

Virtual keys are still the recommended path for generic LLM clients that cannot fetch OAuth tokens. LLM OAuth clients are better when you control the service code and can request a token before calling an LLM proxy. See [Model Router Client Credentials](/docs/platform-model-router-client-credentials-example) for a complete service-app example.

### Managing OAuth Clients

1. Go to **LLM Proxies > Credentials > OAuth Clients**
2. Create an OAuth client and choose its grant type
3. For an application (client credentials): select the LLM proxies it can access and map the provider API keys it can use
4. For acting on behalf of users (authorization code): add the application's redirect URIs
5. Copy the generated `client_id` and `client_secret` (the secret is shown only once)

You can edit a client_credentials client later to update its name, allowed LLM proxies, or provider key mappings; edit an authorization_code client to update its redirect URIs. The grant type is fixed at creation. Rotate the client secret when the existing secret needs to be replaced.

Each OAuth client also has a visibility level — **Personal** (only its creator), **Teams** (members of selected teams), or **Organization** — controlling who can see, edit, rotate, and delete it. New clients default to Personal; sharing with teams requires `llmOauthClient:team-admin`, organization-wide visibility requires `llmOauthClient:admin`, and admins see every client regardless. Visibility only governs management access — it does not change which LLM proxies or provider keys the client's tokens can use at runtime.

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

### On Behalf of Users (Authorization Code)

An application can act on behalf of an individual **user** instead of as itself. It runs the OAuth authorization code flow with the `llm:proxy` scope, the user approves the consent screen, and the application exchanges the code for a user-bound access token used as the proxy bearer token.

Register such an application one of two ways:

- **Pre-registered (recommended for known apps)**: create an OAuth client on the **OAuth Clients** page with the "On behalf of users" grant type and add its redirect URIs. It is confidential — it gets a `client_id` and one-time `client_secret`, and PKCE is required — so only that application can complete the flow. To allow only pre-registered clients, set `ARCHESTRA_AUTH_DCR_ENABLED=false`.
- **Self-registered**: a client registers dynamically (DCR) or via a client-ID metadata document (CIMD) and runs the same flow. These do not use the OAuth Clients page.

The application redirects the user to `GET /api/auth/oauth2/authorize` (`response_type=code`, `scope=llm:proxy`, add `offline_access` for a refresh token, the registered `redirect_uri`, and a PKCE challenge), then exchanges the code at `POST /api/auth/oauth2/token` (`grant_type=authorization_code`, `client_id`, `client_secret`, PKCE verifier).

Either way the token is user-bound and carries no provider keys of its own: provider-specific routes and Model Router resolve provider keys from the authorized user's accessible Model Provider keys (personal keys, org-wide keys, and team keys for teams the user belongs to), and the user's cost limits and policies apply.

#### Proxy access grant

A pre-registered client may optionally carry an **LLM proxy access grant** (its `allowedLlmProxyIds`). Any user who authenticates through the client may then reach those proxies **in addition to** their own role-based access — even proxies they otherwise couldn't reach. The grant is additive (it never removes access) and admin-controlled (only admins register clients and set the list). It lets you gate a restricted proxy behind a specific trusted app: assign the proxy to a team with no members (an org-wide proxy is open to all members), then grant it through the client. Each user's own provider keys, cost limits, and policies still apply.

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

When the Archestra Chat, JWKS auth, or user OAuth Model Router auth resolves a provider key, it follows this priority: conversation key > agent configured key > personal key > team key > organization-wide key > environment variable. If multiple keys exist in the same scope for a provider, the primary key is selected first; otherwise, the oldest key is selected.

## Custom Base URLs

Each LLM API key can have an optional **Base URL** that overrides the [environment-variable default](/docs/platform-deployment#llm-provider-configuration). This is configured when creating or editing an API key in Provider Settings.

Use cases:

- Self-hosted Ollama at a non-default address
- OpenAI-compatible proxies
- Regional endpoints

When a virtual key or OAuth client access token is resolved, the mapped provider key's base URL is used automatically.
