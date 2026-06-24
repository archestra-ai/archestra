---
title: Projects
category: Projects
order: 1
description: Named collections of chats that share files and scheduled runs
lastUpdated: 2026-06-23
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

A project is a named collection of chats that own a shared set of result files. Chats started in a project belong to it for their lifetime, files the agent saves are owned by the project rather than the individual author, and the project's page lists every chat and file in one place. Use a project to keep a body of work — its conversations, its outputs, and its recurring tasks — together and optionally shared with teammates.

## Sharing

A project is private to its owner until shared. Sharing makes it visible to the whole organization or to selected teams; everyone with access can read its chats, start their own chats in it, and work with its files. Mutations to the project itself (rename, icon, description, sharing, deletion) are owner-only, except for holders of `project:admin` (see Finding projects). Deleting a project keeps its chats as ordinary conversations but removes its files.

## Finding projects

The projects list has a search box and a scope filter that mirrors the agents filter. Scope is a project's share visibility: **Personal** (private, owner-only), **Team** (shared with teams — narrow further by team), or **Organization** (shared org-wide); the default shows everything you can see. Search matches a project's name and description.

Holders of `project:admin` get the agents-style owner sub-filter under **Personal**: **My projects** vs **Other users** (with a by-user picker) — an oversight view of other members' private projects. In that view a project admin can edit or delete the project, change its sharing, and view, download, or delete its files — but cannot see or start its chats: the Chats panel is hidden, and the project's conversations remain private to its members.

`project:admin` is additive oversight, not a standalone role: it lets a holder discover other members' projects and act on the project and its files, but never read their chats, and it does not by itself grant schedule control. It layers on the standard `project` permissions — to edit or delete a foreign project a custom role also needs `project:update` / `project:delete` (and `project:read` to see it); to manage that project's scheduled runs it needs `scheduledTask:admin`. The predefined Admin role already holds all of these. Configure custom roles from [Access Control](./platform-access-control).

## Instructions

Every project has an instructions file (`instructions.md`) whose contents are prepended to the system prompt of every chat in the project, so standing guidance — domain context, house style, constraints the agent must always follow — applies to every conversation without being repeated in each prompt. Edit it from the pinned entry at the top of the project's Files panel; owner edits take effect on the next message in any of the project's chats, and empty instructions add nothing. Once saved it is an ordinary project file that agents can read and update, but it cannot be deleted — clear its contents to remove the guidance.

## Files

In a project chat, the files an agent produces (`save_result`, `download_file`) are saved to the project, so anyone with project access can reach them — unlike a personal chat, whose files stay scoped to the conversation that produced them. The chat's Files panel shows the files created in that chat and its attachments, and in a project chat it also lists the project's files; the project page is where you browse a project's full set.

## Scheduled tasks

A schedule runs an agent automatically on a repeating cron schedule, scoped to the project. Each run starts a chat in the project — it appears in the project's session list marked as a scheduled run — and any result it saves lands in the project's files. This makes recurring work (a daily summary, periodic triage) accumulate in the same shared place as the rest of the project.

Schedules are managed from the project page. Pick the agent, write the task prompt, and choose a cron schedule and timezone (defaulted to your browser's). A run executes under the permissions of the user who created the schedule. Editing, enabling/disabling, and deleting a schedule are done from its row.

Callers who cannot pick an agent (no `agent:read`, for example a restricted "basic user" role) do not see the agent selector; their schedules run the organization's default agent.

Every completed run preserves the full agent conversation. Open a run from the project's chats to review it; the owner can continue chatting in the same context, and a user with `scheduledTask:admin` can view (but not continue) other users' runs. See [Access Control](./platform-access-control) for role configuration.
