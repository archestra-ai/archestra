---
title: Chat
category: Agents
order: 2
description: Managing LLM provider API keys for the built-in Chat feature
lastUpdated: 2025-12-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Archestra includes a built-in Chat interface that allows users to interact with AI agents using MCP tools. To use Chat, you need to configure LLM provider API keys.

![Agent Platform Swarm](/docs/platform-chat.png)

### API Keys
Chat will use LLM API Keys configured in Settings -> LLM API Keys. When a chat request is made, the system determines which API key to use in this order:

1. **Profile-specific key** - If the profile has an API key assigned for the provider, use it
2. **Organization default** - Fall back to the organization's default key for that provider
3. **Environment variable** - Final fallback to `ARCHESTRA_CHAT_<PROVIDER>_API_KEY`

### Supported Providers

See [Supported LLM Providers](/docs/platform-supported-llm-providers) for the full list.

## Security Notes

- API keys are stored encrypted using the configured [secrets manager](/docs/platform-secrets-management)
- Keys are never exposed in the UI after creation
- Profile assignments allow separation of billing/usage across teams
