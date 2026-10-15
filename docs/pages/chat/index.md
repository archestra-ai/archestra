---
title: Chat & Projects
description: Start conversations, delegate tasks, attach files, and collaborate with autonomous agents in real time
order: 6
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Ask an agent to investigate an issue, work with attached files, or run a task, then follow its progress in chat. Model requests pass through the [LLM Proxy](/docs/llm-proxy); tool calls use the [MCP Gateway](/docs/mcp/gateway) with your access and configured policies.

![The chat composer with agent and model selectors](/docs/automated_screenshots/chat_composer.webp)

## Starting a Conversation

Choose an agent and prompt it to analyze data, run commands, or generate code.

1. Select **New chat** in the sidebar, or press `Option+N` (or `Alt+N` on Windows/Linux). Starting conversations requires [`chat:create`](/docs/reference/permissions#chat:create).
2. Choose an agent from the **Agent** menu.
3. Enter your prompt in the composer and press `Enter` to send. Press `Escape` to halt an active completion.

You can continue typing while the agent generates a response. Queued messages wait in line and send automatically when the current turn finishes. Viewing past chats requires [`chat:read`](/docs/reference/permissions#chat:read).

## Choosing a Model and Reasoning Depth

Override the default model and reasoning depth for an individual conversation without changing the agent definition.

The model selector displays the active model for the chat. A badge marks whether the model inherits from the agent configuration or the organization default. Choose another model to override it for this session, or select **Reset to default**. Badges like Vision, PDF, and Tools indicate each model's supported modalities.

When a selected model supports extended reasoning, **Reasoning depth** controls thinking intensity: Default, Low, Medium, or High.

## Attaching Files and Running Commands

Upload files directly into the prompt or trigger specialized skills with slash commands.

Select **Attach files** in the composer to upload documents, spreadsheets, or images. Files that the model cannot process directly save into the chat's **Files** panel, where containerized agents can access them on disk. To persist an attachment for reuse across conversations, select **Save to knowledge**. See [Knowledge Files](/docs/knowledge/files).

Type `/` in the composer to display available commands. Every skill granted to your agent appears as an executable command — for example, `/deep-research`. See [Agent Skills](/docs/agents/skills).

Run `/compact` to summarize earlier messages and keep conversations within the model's context window. The **Context usage** ring beside the composer tracks active token consumption and provides a **Compact now** button.

## Approvals and Questions

Review sensitive tool calls and provide real-time clarifications during agent execution.

When a tool requires human approval, execution pauses and an approval card appears inline. Select **Approve** to run the tool, or **Decline** to cancel execution and prompt the agent to adjust its plan.

When an agent asks a question, choose an answer in the card or write a response in the composer. Selecting a choice submits it; dismiss the question if you want the agent to proceed without an answer. Links and commands appear beside the question so you can follow them before answering.

## Managing and Sharing Conversations

Manage conversations from the sidebar or share transcripts across your team.

The sidebar lists recent conversations chronologically. Open a chat's context menu to pin it to the top of the list, rename it, assign it to a [project](/docs/chat/projects), or remove it with [`chat:delete`](/docs/reference/permissions#chat:delete). Press `Cmd+K` (or `Ctrl+K`) to open the search palette and jump across chats instantly.

Open **Chat actions** in the conversation header and choose **Share** to grant access to individual users, teams, or roles. Shared chats are read-only for recipients; viewers can select **Start New Chat from here** to fork the history into their own editable conversation. To save an offline transcript, select **Export Markdown** from the same header menu.

## Encrypted Chats

Keep a chat's saved content encrypted with a key held by its originating browser. The server processes content while handling requests; browser-held encryption protects the stored copies. Organization escrow permits recovery by designated key holders.

To enable encrypted chats and recover them if browser storage is lost, the deployment operator configures key escrow; see [Key Escrow for Encrypted Chats](/docs/admin/security/content-encryption#key-escrow).

Fresh encrypted chats cannot run while **Guardrails enforcement** is active: Archestra returns `409` because encrypted OpenAPPA policy storage is unsupported, before calling the model. Use a standard chat for governed work.

Select the lock icon in the composer, or press `Option+I` (or `Alt+I` on Windows/Linux), before sending your first message. Your browser generates a unique AES key client-side and retains it locally. Archestra encrypts conversation messages, attachments, logs, and error outputs with that key before saving them to the database.

Encrypted conversations normally open only in their originating browser, unless recovered through escrow. Sharing, chat forking, project assignment, compaction, and saving files to knowledge are disabled for encrypted conversations.

<span id="key-escrow"></span>
