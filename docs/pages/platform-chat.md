---
title: Chat
category: Agents
order: 2
description: Built-in Chat interface for working with agents and MCP tools
lastUpdated: 2026-05-12
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

- [`/compact`](#context-compaction) summarizes older conversation history to reduce context usage and help prevent hitting the selected model's context limit. The full chat history remains visible in the conversation.

#### Context Compaction

Context compaction replaces older messages sent to the model with a structured handoff summary while keeping recent turns verbatim. The original chat history remains visible, and compaction events appear in the conversation timeline.

Compaction is handled by the built-in Context Compaction Subagent. Users with `agent:admin` permission can edit its instructions and model from the built-in agent settings. If no model is configured on the subagent, Chat uses the conversation's current provider with a fast model for that provider.

Uploaded text files and PDFs are included in the compaction transcript when extractable text is available in the chat payload. If file text cannot be extracted (for example, a scanned PDF with no text layer), the summary records that limitation instead of implying the full file contents remain in context.
