---
title: Chat
category: Agents
order: 2
description: Built-in Chat interface for working with agents and MCP tools
lastUpdated: 2026-05-26
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

Context compaction replaces older messages sent to the model with a structured handoff summary while keeping recent turns verbatim. In short conversations, Chat can summarize completed earlier work instead of waiting for four user turns. The original chat history remains visible, and compaction events appear in the conversation timeline.

Compaction is handled by the built-in Context Compaction Subagent. Users with `agent:admin` permission can edit its instructions and model from the built-in agent settings. If no model is configured on the subagent, Chat uses the conversation's current provider with a fast model for that provider.

Uploaded text files and PDFs are included in the compaction transcript when extractable text is available in the chat payload. If file text cannot be extracted (for example, a scanned PDF with no text layer), the summary records that limitation instead of implying the full file contents remain in context.

### Attachment Storage

File attachments uploaded in chat are stored in a dedicated `chat_attachments` Postgres table — separate from the chat history. Messages persist only a small reference (`/api/chat/attachments/<id>/content`) in their JSONB content; the bytes never enter the `messages` row. When the conversation is sent to the model, references are materialized back to inline content at request time, and document parts are marked with Anthropic ephemeral prompt caching so re-sending the same files across turns does not re-bill the input tokens. Forking a conversation creates fresh attachment rows scoped to the new conversation rather than aliasing the originals. The 50 MB per-file cap is enforced in the upload UI; Postgres remains the only required service.
