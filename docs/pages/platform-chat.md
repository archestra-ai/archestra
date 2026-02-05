---
title: Chat
category: Archestra Platform
subcategory: Concepts
order: -1
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

## Rich UI Components (MCP UI)

Archestra Chat supports rich UI components via the Model Context Protocol (MCP) UI extension. This allows MCP tools to return structured data that is rendered as interactive components (charts, forms, maps, etc.) directly in the chat interface.

### How it works

1. An MCP tool returns a result containing metadata in the `_meta` field.
2. The `_meta` field specifies the UI component to render and its associated data.
3. Archestra Chat uses the `@mcp-ui/client` library to render the component.

For more information on building MCP servers with UI support, see the [MCP UI Documentation](https://github.com/mcp-ui/mcp-ui).

## Security Notes

- API keys are stored encrypted using the configured [secrets manager](/docs/platform-secrets-management)
- Keys are never exposed in the UI after creation
- Profile assignments allow separation of billing/usage across teams
