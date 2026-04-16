---
title: Scheduled Tasks
category: Agents
order: 3
description: Run agents automatically on a repeating schedule
lastUpdated: 2026-04-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

![Scheduled Tasks list](/docs/automated_screenshots/platform-agent-triggers-schedule_list.webp)

Scheduled Tasks run an agent automatically on a repeating schedule. Each run sends the configured prompt to the agent and records the full conversation. The task always runs under the permissions of the user who created it.

Common use cases: daily standup preparation (fetching tasks and summarizing progress before a daily meeting), or first-line support triage (periodically processing incoming support requests).

## Chat Follow-up

Every completed run preserves the full agent conversation. Open any run from the task's History to review the result and continue chatting with the agent in the same context — ask follow-up questions, request changes, or dig deeper into the output.

![Task detail with run history](/docs/automated_screenshots/platform-agent-triggers-schedule_detail.webp)

Each run opens as a regular chat where you can continue the conversation.

![Completed run conversation](/docs/automated_screenshots/platform-agent-triggers-schedule_run.webp)

## Permissions

The `scheduledTask` resource controls access. Without `admin` permission, users only see the tasks they created. Admins can view and manage all tasks across the organization. See [Access Control](/docs/platform-access-control) for role configuration.
