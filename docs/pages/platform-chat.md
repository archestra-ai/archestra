---
title: Chat
category: Archestra Platform
order: 7
description: Managing LLM provider API keys for the built-in Chat feature
lastUpdated: 2025-12-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Archestra includes a built-in Chat interface that allows users to interact with AI agents using MCP tools. To use Chat, you need to configure LLM provider API keys.

## Multi-Provider API Key Management

![LLM Provider API Keys Settings](/docs/automated_screenshots/platform_llm_api_keys_settings.png)

The platform supports multiple LLM provider API keys with granular control:

- **Multiple keys per provider** - Create as many API keys as needed for each provider
- **Organization defaults** - Set one key per provider as the organization-wide default
- **Profile assignments** - Assign specific keys to individual profiles for fine-grained control
- **Bulk assignment** - Select multiple API keys and assign them to profiles at once

This is useful when different teams or projects need to use different API keys for billing or access control purposes.

> **Note:** Only one API key per provider can be assigned to a given profile. If you assign a new key of the same provider, the previous assignment will be replaced. However, you can assign keys from different providers (e.g., one Anthropic key and one OpenAI key) to the same profile.

### API Key Resolution Order

When a chat request is made, the system determines which API key to use in this order:

1. **Profile-specific key** - If the profile has an API key assigned for the provider, use it
2. **Organization default** - Fall back to the organization's default key for that provider
3. **Environment variable** - Final fallback to `ARCHESTRA_CHAT_<PROVIDER>_API_KEY`

### Supported Providers

See [Supported LLM Providers](/docs/platform-supported-llm-providers) for the full list.

## Security Notes

- API keys are stored encrypted using the configured [secrets manager](/docs/platform-secrets-management)
- Keys are never exposed in the UI after creation
- Profile assignments allow separation of billing/usage across teams
