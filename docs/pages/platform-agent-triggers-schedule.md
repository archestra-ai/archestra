---
title: Scheduled Tasks
category: Agents
order: 3
description: Run agents automatically on a repeating schedule
lastUpdated: 2026-05-07
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

![Scheduled Tasks list](/docs/automated_screenshots/platform-agent-triggers-schedule_list.webp)

Scheduled Tasks run an agent automatically on a repeating schedule. Each run sends the configured prompt to the agent and records the full conversation. The task always runs under the permissions of the user who created it.

Common use cases: daily standup preparation (fetching tasks and summarizing progress before a daily meeting), or first-line support triage (periodically processing incoming support requests).

## Convert from Chat

Any chat conversation can be turned into a Scheduled Task directly from the chat header. Click **Schedule** on the conversation toolbar (requires `scheduledTask:create`) to open the configuration dialog. Archestra pre-selects:

- **Agent**: the agent that handled the most recent interaction in the chat. If the chat used `swap_agent`/`swap_to_default_agent`, the last active agent is chosen.
Falls back to the user's default agent, then the organization's default.
- **Name**: derived from the conversation title.
- **Prompt**: by default, the full conversation is summarized into a standalone recurring prompt via LLM on save (see [Schedule Conversion built-in agent](/docs/platform-built-in-agents-schedule-conversion) for where that LLM and prompt are configured). Toggle off **AI summary** to write the prompt manually.

Agents can also trigger this conversion through the Archestra MCP tool `convert_conversation_to_scheduled_task` — for example, saying "save this as a weekday 9am task" in chat.

### Reply in this chat

When **Post scheduled replies in this conversation** is enabled, each successful run is appended to the current chat instead of a fresh run thread. You can pick any agent that has already participated in the conversation — the current chat agent or any historical participant (e.g. agents left behind by `swap_agent`). Agents that never ran in this chat are filtered out so the conversation stays self-consistent.

If the conversation's agent later changes (e.g. a subsequent `swap_agent` call) and the scheduled task's agent is no longer valid for the chat, the task auto-unlinks from the conversation on its next run and continues as standalone runs. The originating run is still marked successful and its result carries a warning explaining the unlink.

## Chat Follow-up

Every completed run preserves the full agent conversation. Open any run from the task's History to review the result. Task owners can continue chatting with the agent in the same context to ask follow-up questions, request changes, or dig deeper into the output.

![Task detail with run history](/docs/automated_screenshots/platform-agent-triggers-schedule_detail.webp)

Each run opens as a chat. Users with `scheduledTask:admin` can view other users' run conversations, but only the conversation owner can continue them. To follow up on another user's run, start a new chat from the run conversation; the new chat copies the existing messages and runs under your permissions.

![Completed run conversation](/docs/automated_screenshots/platform-agent-triggers-schedule_run.webp)

## Permissions

The `scheduledTask` resource controls access. Without `scheduledTask:admin`, users only see the tasks they created. Users with `scheduledTask:admin` can view and manage all tasks across the organization. See [Access Control](/docs/platform-access-control) for role configuration.
