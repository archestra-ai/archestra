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

## Chat Follow-up

Every completed run preserves the full agent conversation. Open any run from the task's History to review the result. Task owners can continue chatting with the agent in the same context to ask follow-up questions, request changes, or dig deeper into the output.

![Task detail with run history](/docs/automated_screenshots/platform-agent-triggers-schedule_detail.webp)

Each run opens as a chat. Users with `scheduledTask:admin` can view other users' run conversations, but only the conversation owner can continue them. To follow up on another user's run, start a new chat from the run conversation; the new chat copies the existing messages and runs under your permissions.

![Completed run conversation](/docs/automated_screenshots/platform-agent-triggers-schedule_run.webp)

## Permissions

The `scheduledTask` resource controls access. Without `scheduledTask:admin`, users only see the tasks they created. Users with `scheduledTask:admin` can view and manage all tasks across the organization. See [Access Control](/docs/platform-access-control) for role configuration.
