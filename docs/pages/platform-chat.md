---
title: Chat
category: Agents
order: 2
description: Built-in Chat interface for working with agents and MCP tools
lastUpdated: 2026-05-11
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Archestra includes a built-in Chat interface for working with agents, MCP tools, files, browser actions, and model selection in one place.

![Agent Platform Swarm](/docs/platform-chat.webp)

### Supported Providers

Chat supports the LLM providers configured for your workspace. See [Supported LLM Providers](/docs/platform-supported-llm-providers) for the full list.

### Available Commands

Type `/` in the prompt input to open available chat commands.

- `/compact` summarizes older conversation history to reduce context usage and help prevent hitting the selected model's context limit. The full chat history remains visible in the conversation.
