---
title: Projects
category: Projects
order: 1
description: Named collections of chats that share files and scheduled runs
lastUpdated: 2026-06-18
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

A project is a named collection of chats that own a shared set of result files. Chats started in a project belong to it for their lifetime, files the agent saves are owned by the project rather than the individual author, and the project's page lists every chat and file in one place. Use a project to keep a body of work — its conversations, its outputs, and its recurring tasks — together and optionally shared with teammates.

## Sharing

A project is private to its owner until shared. Sharing makes it visible to the whole organization or to selected teams; everyone with access can read its chats, start their own chats in it, and work with its files. Mutations to the project itself (rename, icon, description, sharing, deletion) stay owner-only. Deleting a project keeps its chats as ordinary conversations but removes its files.

## Files

In a project chat, the files an agent produces (`save_result`, `download_file`) are saved to the project, so anyone with project access can reach them — unlike a personal chat, whose files stay in the author's My Files. The chat's Files panel shows only the files the agent actually touched in that conversation (created, read, or edited), not every file it could reach; browse the full set on the project page or in My Files.

## Scheduled tasks

A schedule runs an agent automatically on a repeating cron schedule, scoped to the project. Each run starts a chat in the project — it appears in the project's session list marked as a scheduled run — and any result it saves lands in the project's files. This makes recurring work (a daily summary, periodic triage) accumulate in the same shared place as the rest of the project.

Schedules are managed from the project page. Pick the agent, write the task prompt, and choose a cron schedule and timezone (defaulted to your browser's). A run executes under the permissions of the user who created the schedule. Editing, enabling/disabling, and deleting a schedule are done from its row.

Callers who cannot pick an agent (no `agent:read`, for example a restricted "basic user" role) do not see the agent selector; their schedules run the organization's default agent.

Every completed run preserves the full agent conversation. Open a run from the project's chats to review it; the owner can continue chatting in the same context, and a user with `scheduledTask:admin` can view (but not continue) other users' runs. See [Access Control](./platform-access-control) for role configuration.
