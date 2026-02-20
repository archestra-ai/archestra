---
title: Authentication
category: LLM Proxy
order: 2
description: Authentication methods for the LLM Proxy
lastUpdated: 2026-02-20
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This page documents the authentication methods available for the LLM Proxy:
1. Direct provider API keys (existing, pass-through)
2. Virtual API keys (archestra_-prefixed tokens)
3. Per-key custom base URLs
-->

The LLM Proxy supports two authentication methods: direct provider API keys and virtual API keys.

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

## Custom Base URLs

Each LLM API key can have an optional **Base URL** that overrides the environment-variable default. This is configured when creating or editing an API key in Settings > LLM API Keys.

Use cases:
- Self-hosted Ollama at a non-default address
- LiteLLM or other OpenAI-compatible proxies
- Regional endpoints

When a virtual key is resolved, its parent key's base URL is used automatically.
