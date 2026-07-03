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

A chat answers a question and scrolls away; a project is where agent work accumulates. Chats started in a project belong to it for their lifetime, files the agent saves are owned by the project rather than the individual author, and standing instructions and scheduled runs live in the same place — one workspace you can share with teams or the whole organization.

![A project with its chats, files, and monthly schedule](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a project

Create a project from scratch on the Projects page, or promote an existing chat that has outgrown itself: choose **Create project** from the chat's menu in the sidebar, or ask the agent ("create a project out of this chat") when it has the `create_project_from_conversation` tool. The chat and its saved files move into the new project; only the chat's owner can do this, and only for a chat not already in a project.

![Chat sidebar menu with the Create project action](/docs/automated_screenshots/platform-projects_create-from-chat.webp)

## Files

Files the agent saves (`save_file`, `download_file`) land in the project, where everyone with access can reach them — instead of staying scoped to the chat that produced them. You can also add files directly: drag and drop them onto the Files panel (up to 25 MB per file). A name collision appends a number; an upload never overwrites an existing file. Plain-text and Markdown files can be edited in place.

![Project files listed next to the project's chats](/docs/automated_screenshots/platform-projects_files-panel.webp)

One file is special: `instructions.md`, the pinned entry at the top of the Files panel. Its contents are prepended to the system prompt of every chat in the project — standing rules written once, applied to every conversation. Edits take effect on the next message. The file cannot be deleted; clear its contents to remove the guidance.

![Editing project instructions](/docs/automated_screenshots/platform-projects_instructions-editor.webp)

## Scheduled tasks

A schedule runs an agent on a cron schedule (with a timezone, defaulted to your browser's), scoped to the project. Pick the agent and write the task prompt; each run executes under the permissions of the user who created the schedule, starts a chat in the project marked as a scheduled run, and saves its outputs to the project's files. The full conversation of every run is preserved — open it to review what the agent did, and continue chatting in the same context.

![New schedule dialog](/docs/automated_screenshots/platform-projects_schedule-dialog.webp)

## Use case: vendor invoice approvals

A finance person approves incoming invoices against the company's vendor list, and a monthly report generates itself:

- **Files** hold the living data: `approved-vendors.csv`, uploaded once and edited in place as vendors change, plus the reports the agent writes.
- **Instructions** hold the standing rules: "Match every invoice against approved-vendors.csv. Flag any vendor not on the list. Amounts over $10,000 need CFO sign-off."
- **Chats** are the daily work — "check this invoice from Acme GmbH" — and every one of them follows the instructions and can read the vendor list.
- **A schedule** closes the loop: on the 1st of each month, an agent pulls last month's approvals through an accounting MCP server and saves `invoice-report-2026-06.md` into project files, as a reviewable chat in the project.
- **Sharing** with the Finance team means everyone approves against the same list and reads the same reports.

![Sharing the project with the Finance team](/docs/automated_screenshots/platform-projects_sharing-dialog.webp)

A project is private until shared — with selected teams or the whole organization. Everyone with access reads its chats, starts their own, and works with its files; mutations to the project itself (rename, description, sharing, deletion) stay owner-only. Deleting a project keeps its chats as ordinary conversations but removes its files and schedules. `project:admin` holders can additionally reach other members' projects and files — never their chats; see [Access Control](./platform-access-control).
