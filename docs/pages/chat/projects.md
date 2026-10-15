---
title: Projects
description: Keep chats, agent runs, files, instructions, and schedules in one shared project
order: 1
lastUpdated: 2026-10-15
---

Keep an investigation's chats, files, agent runs, and schedules together. Project instructions carry across conversations, so a new agent can use the same reference files and conventions.

![A project with its chat composer, files panel, and schedules](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a Project

Create a project before starting work that needs shared files or recurring tasks.

1. Go to **Projects** and select **New project**. Creating projects requires [`project:create`](/docs/reference/permissions#project:create).
2. Enter a project name and optional description.
3. Choose a default agent if new chats and schedules should start with the same agent. Save and confirm the project opens.

You can also convert an existing chat into a project by opening the chat's context menu and selecting **Create project**. To move an ongoing conversation or Agent Runtime session into a project, select **Change project** from its menu. Choosing **Remove from project** returns the session to the main chat list.

## Shared Files and Instructions

Put reusable references in the project's **Files** panel and instructions in its pinned `instructions.md`.

Drop files directly into the project's **Files** panel. Files produced by agents during project chats also appear here, making them accessible to subsequent conversations in the same project. Text and Markdown files can be edited directly inside the panel.

For example, write "Check the attached incident timeline before proposing a cause" in `instructions.md`. Start a new project chat and ask the agent to identify the reference file to check that the context is available.

External coding clients like Claude Code can read and write project files through the [Archestra MCP Server](/docs/reference/archestra-mcp-server). See [Knowledge Files](/docs/knowledge/files#chat-project-and-knowledge-files) to decide whether assets belong in a project or a shared knowledge base.

## Scheduled Tasks

Ask an agent in a project chat to schedule a task, or create it from **New schedule**. Each run keeps its own history inside the project.

1. Select **New schedule** on the project page. Scheduling tasks requires [`scheduledTask:create`](/docs/reference/permissions#scheduledTask:create).
2. Choose an agent and enter the task prompt.
3. Choose a cadence and time zone. For example, `0 9 * * 1-5` runs at 09:00 on weekdays in that zone.
4. Save, check the next run time, and use **Run now** to verify the prompt and agent before relying on the schedule.

Open a run in the schedule history to inspect its conversation or Agent Runtime session, tool calls, and files. Failed runs keep their status and history for investigation.

Pause a schedule to halt automatic triggers while retaining the ability to trigger manual test runs ([`scheduledTask:update`](/docs/reference/permissions#scheduledTask:update)). Deleting a schedule with [`scheduledTask:delete`](/docs/reference/permissions#scheduledTask:delete) removes its cadence and schedule definition, but preserves all past conversations and session history.

## Sharing and Access Control

Share the project when another person needs its files and instructions; conversation access remains separate.

Configure member access in project settings under **Access**. You can grant permissions to individual users, teams, service accounts, roles, or the entire organization.

Viewing projects and their shared files requires [`project:read`](/docs/reference/permissions#project:read). Modifying project instructions or settings requires [`project:update`](/docs/reference/permissions#project:update). Viewing another member's chats inside a project requires separate conversation read access, and only the author of an Agent Runtime session can attach to its interactive container shell.

Transfer project ownership to another member from the permissions tab. The previous owner retains Full access, and all files, schedules, instructions, and past conversations remain intact.

## Project Labels

Use labels to find projects by team or stage, such as `team: infra` or `stage: active`.

Add labels under **Advanced** when creating or editing a project (for example, `team: infra` or `stage: active`).

Use the label filter bar on the **Projects** page to narrow down projects by key and value.

## Deleting and Restoring Projects

Delete a finished project to move it to the trash. Check whether you need its files and schedules before deleting permanently.

Deleting a project moves it to the trash ([`project:delete`](/docs/reference/permissions#project:delete)). Its conversations and runtime sessions return to the main chat list, while project files and schedules are hidden.

To recover a project, select the **Deleted** status filter on the **Projects** page and click **Restore**.

Selecting **Delete permanently** purges all project files, instructions, and schedules. Past conversation transcripts and runtime session logs are preserved.
