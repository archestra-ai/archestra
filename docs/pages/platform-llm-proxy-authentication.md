---
title: Authentication
category: LLM Proxy
order: 2
description: Authentication methods for the LLM Proxy
lastUpdated: 2026-02-20
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

The LLM Proxy supports three authentication methods: direct provider API keys, virtual API keys, and JWKS via an external identity provider.

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

Virtual API keys are `archestra_`-prefixed tokens that map to a real provider API key stored in Archestra. The real key never leaves Archestra.

### Benefits

- **Key isolation**: Provider keys stay in Archestra; clients only see the virtual token
- **Revocable**: Delete a virtual key without rotating the underlying provider key
- **Expirable**: Set an optional expiration date
- **Per-key base URL**: The underlying provider key can have a custom base URL (e.g., for proxies or self-hosted endpoints)

### Creating Virtual Keys

1. Go to **Settings > LLM API Keys**
2. Click the edit icon on an existing API key
3. In the **Virtual API Keys** section at the bottom, enter a name and click the add button
4. Copy the generated `archestra_...` token (shown only once)

### Using Virtual Keys

Use the virtual key in place of the provider key:

```bash
curl -X POST "https://archestra.example.com/v1/openai/{proxyId}/chat/completions" \
  -H "Authorization: Bearer archestra_abc123def456..." \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'
```

The proxy resolves the virtual key to the real provider key and base URL, then forwards the request.

### Provider Matching

Each virtual key is tied to a specific provider. Using an OpenAI virtual key on the Anthropic proxy endpoint returns a `400` error.

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

When the Archestra Chat or JWKS auth resolves a provider key, it follows this priority: personal key > team key > organization-wide key > environment variable.

## Custom Base URLs

Each LLM API key can have an optional **Base URL** that overrides the [environment-variable default](/docs/platform-deployment#llm-provider-configuration). This is configured when creating or editing an API key in Provider Settings.

Use cases:
- Self-hosted Ollama at a non-default address
- LiteLLM or other OpenAI-compatible proxies
- Regional endpoints

When a virtual key is resolved, its parent key's base URL is used automatically.
