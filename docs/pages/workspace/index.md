---
title: Chat & Workspaces
description: Collaborate interactively with agents, organize work in projects, and run custom apps in Archestra's unified workspace
order: 6
lastUpdated: 2026-10-12
---

The workspace is where you collaborate interactively with autonomous agents, test skills, and run lightweight apps. Every prompt flows through the [LLM Proxy](/docs/llm-proxy) and [MCP Gateway](/docs/mcp/gateway), enforcing guardrails, access policies, and audit logging.

![The chat composer with agent and model selectors](/docs/automated_screenshots/chat_composer.webp)

## Collaborating in the Workspace

Every interactive session connects prompts, tools, and shared context while preserving organizational guardrails.

- **Prompt routing:** Prompts flow through the LLM proxy with active [OpenAPPA guardrails](/docs/agents/guardrails) and model router configurations.
- **Tool execution:** Agents invoke tools across configured [MCP servers](/docs/mcp/servers) using your identity or assigned team service accounts.
- **Audit trail:** Every turn, tool invocation, and file modification produces structured audit records.

## Workspace Capabilities

Workspaces combine real-time conversation, long-term project organization, and interactive application builders.

- **[Interactive Chat](/docs/workspace/chat):** Delegate tasks, adjust reasoning depth, attach reference files, invoke slash commands, and review tool calls in real time.
- **[Projects & Schedules](/docs/workspace/projects):** Group conversations, dedicated Agent Runtime sessions, shared files, instructions, and scheduled tasks into a unified workspace.
- **[Interactive Apps](/docs/workspace/apps):** Build on demand by prompting an agent, or launch sandboxed tools and dashboards from installed MCP servers.

## Code Sandbox

Agents in the workspace execute code and scripts inside an isolated container environment provisioned per session.

Uploaded documents and files created during a run persist at `/home/sandbox/attachments`. Tool execution outputs truncate at 64 KB in the feed, with full outputs retained in the side panel. For container lifecycle settings and image configuration, see [Agent Runtime](/docs/agents/runtime).

## Access and Security

Workspaces enforce granular permissions for creation, deletion, and cross-team sharing.

Starting conversations requires [`chat:create`](/docs/reference/permissions#chat:create), creating projects requires [`project:create`](/docs/reference/permissions#project:create), and publishing apps requires [`app:create`](/docs/reference/permissions#app:create). Shared chats and projects maintain strict credential boundaries: viewers execute tools under their own identities. To protect sensitive discussions with browser-held client keys, configure [Encrypted Chats](/docs/workspace/chat#encrypted-chats).

<span id="encrypted-chats"></span><span id="key-escrow"></span>
