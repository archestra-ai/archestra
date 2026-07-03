---
title: Projects
category: Agents
order: 3
description: A shared workspace to organize your work
lastUpdated: 2026-07-03
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

A project is a shared workspace that keeps a body of work together: its chats, the files they produce, standing instructions, and scheduled runs. Chats started in a project belong to it for their lifetime, and files the agent saves are owned by the project rather than the individual author. A project is private to its owner until shared with teams or the whole organization.

![A project with its chats, files, and monthly schedule](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a Project

Create a project from the Projects page, or convert an existing chat: choose **Create project** from the chat's menu in the sidebar, or ask the agent ("create a project out of this chat") when it has the `create_project_from_conversation` tool assigned. The chat and its saved files move into the new project. Only the chat's owner can do this, and only for a chat that is not already in a project.

![Chat sidebar menu with the Create project action](/docs/automated_screenshots/platform-projects_create-from-chat.webp)

## Files

Files the agent saves (`save_file`, `download_file`) are stored in the project, so anyone with project access can reach them — unlike a personal chat, whose files stay scoped to the conversation that produced them. You can also upload files directly: drag and drop them onto the Files panel (up to 25 MB each). A name collision appends a number; an upload never overwrites an existing file. Plain-text and Markdown files can be edited in place.

![Project files listed next to the project's chats](/docs/automated_screenshots/platform-projects_files-panel.webp)

Every project has an `instructions.md` file, pinned at the top of the Files panel. Its contents are prepended to the system prompt of every chat in the project, so standing guidance applies to every conversation without being repeated in each prompt. Edits take effect on the next message. The file cannot be deleted; clear its contents to remove the guidance.

![Editing project instructions](/docs/automated_screenshots/platform-projects_instructions-editor.webp)

## Scheduled Tasks

A schedule runs an agent automatically on a repeating cron schedule, scoped to the project. Pick the agent, write the task prompt, and choose a cron schedule and timezone (defaulted to your browser's). A run executes under the permissions of the user who created the schedule. Each run starts a chat in the project, marked as a scheduled run, and any files it saves land in the project's files. Every completed run preserves the full conversation; open it from the project's chats to review it and continue in the same context.

![New schedule dialog](/docs/automated_screenshots/platform-projects_schedule-dialog.webp)

## Use Case: Vendor Invoice Approvals

A finance person approves incoming invoices against the company's vendor list, and a monthly report generates itself:

- **Files** hold the living data: `approved-vendors.csv`, uploaded once and edited in place as vendors change, plus the reports the agent writes.
- **Instructions** hold the standing rules: "Match every invoice against approved-vendors.csv. Flag any vendor not on the list. Amounts over $10,000 need CFO sign-off."
- **Chats** are the daily work — "check this invoice from Acme GmbH" — and every one of them follows the instructions and can read the vendor list.
- **A schedule** closes the loop: on the 1st of each month, an agent pulls last month's approvals through an accounting MCP server and saves `invoice-report-2026-06.md` into project files, as a reviewable chat in the project.
- **Sharing** with the Finance team means everyone approves against the same list and reads the same reports.

![Sharing the project with the Finance team](/docs/automated_screenshots/platform-projects_sharing-dialog.webp)

Everyone with access to a shared project can read its chats, start their own, and work with its files. Mutations to the project itself (rename, description, sharing, deletion) are owner-only. Deleting a project keeps its chats as ordinary conversations but removes its files and schedules. `project:admin` holders can additionally reach other members' projects and files — never their chats. See [Access Control](./platform-access-control) for role configuration.
