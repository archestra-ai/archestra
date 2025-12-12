---
title: Chat & LLM Provider API Keys
category: Archestra Platform
subcategory: Features
order: 8
description: Managing LLM provider API keys for the built-in Chat feature
lastUpdated: 2025-12-11
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Archestra includes a built-in Chat interface that allows users to interact with AI agents using MCP tools. To use Chat, you need to configure LLM provider API keys.

## Multi-Provider API Key Management

The platform supports multiple LLM provider API keys with granular control:

- **Multiple keys per provider** - Create as many API keys as needed for each provider
- **Organization defaults** - Set one key per provider as the organization-wide default
- **Profile assignments** - Assign specific keys to individual profiles for fine-grained control

## API Key Resolution Order

When a chat request is made, the system determines which API key to use in this order:

1. **Profile-specific key** - If the profile has an API key assigned for the provider, use it
2. **Organization default** - Fall back to the organization's default key for that provider
3. **Environment variable** - Final fallback to `ARCHESTRA_CHAT_ANTHROPIC_API_KEY` (for Anthropic)

## Supported Providers

| Provider  | Status      |
| --------- | ----------- |
| Anthropic | Supported   |
| OpenAI    | Coming Soon |
| Gemini    | Coming Soon |

## Setting Up API Keys

Navigate to **Settings → Chat** to manage API keys:

1. Click **Add API Key**
2. Enter a descriptive name
3. Select the provider (Anthropic currently supported)
4. Paste your API key
5. Optionally check "Set as organization default"

## Profile Assignments

To assign an API key to specific profiles:

1. Find the key in the table
2. Click the actions menu (three dots)
3. Select **Manage Profiles**
4. Check the profiles that should use this key
5. Click **Save**

This is useful when different teams or projects need to use different API keys for billing or access control purposes.

## Security Notes

- API keys are stored encrypted using the configured secrets manager
- Keys are never exposed in the UI after creation
- Profile assignments allow separation of billing/usage across teams
