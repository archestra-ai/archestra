---
title: Projects & Schedules
description: Keep chats, agent runs, files, instructions, and schedules in one shared workspace
order: 1
lastUpdated: 2026-10-11
---

A project groups conversations, dedicated Agent Runtime sessions, shared files, instructions, and scheduled tasks into a unified workspace. Start with a private workspace, then grant access to team members as work progresses.

![A project with its chat composer, files panel, and schedules](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a Project

Organize related conversations, agent sessions, and persistent assets into a scoped workspace.

1. Go to **Projects** and select **New project**. Creating projects requires [`project:create`](/docs/reference/permissions#project:create).
2. Enter a project name and optional description.
3. Configure an optional default agent to preselect that agent for new chats and schedules.

You can also convert an existing chat into a project by opening the chat's context menu and selecting **Create project**. To move an ongoing conversation or Agent Runtime session into a project, select **Change project** from its menu. Choosing **Remove from project** returns the session to the main workspace list.

## Shared Files and Instructions

Provide shared reference documentation, assets, and project-wide operating instructions across all conversations.

Drop files directly into the project's **Files** panel. Files produced by agents during project chats also appear here, making them accessible to subsequent conversations in the same project. Text and Markdown files can be edited directly inside the panel.

Edit the pinned `instructions.md` file to supply overarching instructions to every agent run in the project (for example, repository conventions, triage guidelines, or release checklists).

External coding clients like Claude Code can read and write project files through the [Archestra MCP Server](/docs/reference/archestra-mcp-server). See [Knowledge Files](/docs/knowledge/files#chat-project-and-knowledge-files) to decide whether assets belong in a project or a shared knowledge base.

## Scheduled Tasks

Run recurring agent workflows on an automated schedule with recorded execution logs.

1. Select **New schedule** on the project page. Scheduling tasks requires [`scheduledTask:create`](/docs/reference/permissions#scheduledTask:create).
2. Choose an agent and enter the task prompt.
3. Set the cadence using a cron expression or interval, and select the target time zone.

Each scheduled run executes as an independent conversation or Agent Runtime session inside the project. Open any run from the schedule history to follow real-time progress, review tool calls, and inspect outputs. Observability records execution status with [`schedule_trigger_runs_total`](/docs/admin/observability/metrics#schedule_trigger_runs_total).

Pause a schedule to halt automatic triggers while retaining the ability to trigger manual test runs ([`scheduledTask:update`](/docs/reference/permissions#scheduledTask:update)). Deleting a schedule with [`scheduledTask:delete`](/docs/reference/permissions#scheduledTask:delete) removes its cadence and schedule definition, but preserves all past conversations and session history.

## Sharing and Access Control

Control access to project files, agent sessions, and execution permissions across your organization.

Configure member access in project settings under **Access**. You can grant permissions to individual users, teams, service accounts, roles, or the entire organization.

Viewing projects and their shared files requires [`project:read`](/docs/reference/permissions#project:read). Modifying project instructions or settings requires [`project:update`](/docs/reference/permissions#project:update). Viewing another member's chats inside a project requires separate conversation read access, and only the author of an Agent Runtime session can attach to its interactive container shell.

Transfer project ownership to another member from the permissions tab. The previous owner retains Full access, and all files, schedules, instructions, and past conversations remain intact.

## Project Labels

Categorize projects with key-value labels to filter active workspaces across large teams.

Add labels under **Advanced** when creating or editing a project (for example, `team: infra` or `stage: active`).

Use the label filter bar on the **Projects** page to narrow down workspaces by key and value.

## Deleting and Restoring Projects

Move finished projects to the trash or restore previously removed workspaces.

Deleting a project moves it to the trash ([`project:delete`](/docs/reference/permissions#project:delete)). Its conversations and runtime sessions return to the main workspace list, while project files and schedules are hidden.

To recover a project, select the **Deleted** status filter on the **Projects** page and click **Restore**.

Selecting **Delete permanently** purges all project files, instructions, and schedules. Past conversation transcripts and runtime session logs are preserved.
