---
title: Chat & Workspaces
description: Work with agents, files, projects, and apps in Archestra's unified workspace
order: 6
lastUpdated: 2026-10-11
---

The workspace is where you collaborate interactively with autonomous agents, test skills, and run lightweight apps. Every prompt flows through the [LLM Proxy](/docs/llm-proxy) and [MCP Gateway](/docs/mcp/gateway), enforcing guardrails, access policies, and audit logging.

![The chat composer with agent and model selectors](/docs/automated_screenshots/chat_composer.webp)

## Starting a Chat

Start a conversation to delegate tasks to an agent, attach reference files, and collaborate in real time.

1. Select **New chat** in the sidebar, or press `Alt+N`.
2. Choose an agent from the **Agent** menu. Starting conversations requires [`chat:create`](/docs/reference/permissions#chat:create).
3. Enter your prompt in the composer and press `Enter` to send. Press `Escape` to halt an active completion.

You can continue typing while the agent generates a response. Queued messages wait in line and send automatically when the current turn finishes. Viewing past chats requires [`chat:read`](/docs/reference/permissions#chat:read).

## Choosing a Model

Override the default model and reasoning depth for an individual conversation without changing the agent definition.

The model selector displays the active model for the chat. A badge marks whether the model inherits from the agent configuration or the organization default. Choose another model to override it for this session, or select **Reset to default**. Badges like Vision, PDF, and Tools indicate each model's supported modalities.

When a selected model supports extended reasoning, **Reasoning depth** controls thinking intensity: Default, Low, Medium, or High.

## Attaching Files

Upload files directly into the prompt to provide context for the current turn.

Select **Attach files** in the composer to upload documents, spreadsheets, or images. Files that the model cannot process directly save into the chat's **Files** panel, where containerized agents can access them on disk. To persist an attachment for reuse across conversations, select **Save to knowledge**. See [Knowledge Files](/docs/knowledge/files).

## Skills and Commands

Trigger agent skills or maintenance actions directly using slash commands.

Type `/` in the composer to display available commands. Every skill granted to your agent appears as an executable command — for example, `/deep-research`. See [Agent Skills](/docs/agents/skills).

Run `/compact` to summarize earlier messages and keep conversations within the model's context window. The **Context usage** ring beside the composer tracks active token consumption and provides a **Compact now** button.

## Approvals and Questions

Review sensitive tool calls and provide real-time clarifications during agent execution.

When a tool requires human approval, execution pauses and an approval card appears inline. Select **Approve** to run the tool, or **Decline** to cancel execution and prompt the agent to adjust its plan.

If an agent requires clarification mid-run, an interactive question prompt renders in the message feed. Submit your response directly in the card or select **Dismiss question**.

## Message Actions and Feedback

Refine prompt inputs or correct model replies directly in the message history.

Hover over any message to access quick actions: copy text, edit content, or regenerate a completion. Rate answers with **Good response** or **Bad response** to log feedback for observability. Editing an earlier user message truncates subsequent history and resends the prompt; editing an assistant message updates the stored transcript directly.

## Workspace Side Panel

Inspect generated artifacts, follow live browser tools, and run interactive apps alongside your conversation.

The side panel beside the message thread includes three tabs:

- **Files** — Displays attachments, files written by the agent, and code artifacts that can be downloaded or exported as PDF. In a project chat, this panel displays the project's shared files.
- **Browser** — Renders the real-time browser preview when an agent navigates web pages using browser automation tools.
- **Apps** — Displays [interactive apps](/docs/workspace/apps) embedded or launched within the active conversation.

## Organizing Chats

Manage conversations from the sidebar or jump between active sessions with keyboard navigation.

The sidebar lists recent conversations chronologically. Open a chat's context menu to pin it to the top of the list, rename it, assign it to a [project](/docs/workspace/projects), or remove it with [`chat:delete`](/docs/reference/permissions#chat:delete). Press `Cmd+K` (or `Ctrl+K`) to open the search palette and jump across chats instantly.

## Sharing a Chat

Share conversation transcripts with team members or export discussions for offline documentation.

Open **Chat actions** in the conversation header and choose **Share**. Share with individual users, teams, service accounts, roles, or everyone in the organization. Shared chats are read-only for recipients; viewers can select **Start New Chat from here** to fork the history into their own editable conversation.

To save an offline transcript, select **Export Markdown** from the same header menu.

## Encrypted Chats

Protect sensitive discussions with end-to-end encryption where only the originating browser holds the decryption key.

Select the lock icon in the composer, or press `Alt+I`, before sending your first message. Your browser generates a unique AES key client-side and retains it locally. Archestra encrypts conversation messages, attachments, logs, and error outputs with that key before saving them to the database.

Encrypted conversations open only on the browser and device that created them. On other devices, the conversation appears in the list, but its encrypted content cannot be unlocked.

Because encryption protects stored records rather than real-time generation, the LLM provider still processes message prompts. Sharing, chat forking, project assignment, compaction, and saving files to knowledge are disabled for encrypted conversations.

### Key Escrow

Configure an organization escrow public key so designated key holders can recover encrypted chats if local browser access is lost.

Setting [`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/reference/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) enables encrypted chats across your organization. Archestra encrypts each conversation's local encryption key with this RSA public key before saving it. Key holders can recover conversations offline using their private key; see [Recovering an Encrypted Chat](/docs/admin/security/content-encryption#recovering-an-encrypted-chat).
