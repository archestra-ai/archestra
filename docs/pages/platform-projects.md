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

A chat answers a question and scrolls away; a project is where agent work accumulates. Chats started in a project belong to it for their lifetime, files the agent saves are owned by the project rather than the individual author, and standing instructions and scheduled runs live in the same place — one workspace you can share with teammates. This page follows one example throughout: a "Vendor Invoice Approvals" project, where a finance person checks incoming invoices against the company's vendor list and a monthly report writes itself.

![Vendor Invoice Approvals project with its chats, files, and monthly schedule](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Start a project

Create a project from the Projects page, or promote an existing chat that has outgrown itself: choose **Create project** from the chat's menu in the sidebar, or ask the agent ("create a project out of this chat") when it has the `create_project_from_conversation` tool. The chat and its saved files move into the new project; only the chat's owner can do this, and only for a chat not already in a project.

![Chat sidebar menu with the Create project action](/docs/automated_screenshots/platform-projects_create-from-chat.webp)

## Teach it the rules: instructions

Every project has an `instructions.md` file whose contents are prepended to the system prompt of every chat in the project — the standing rules, written once. For invoice approvals: "Match every invoice against approved-vendors.csv. Flag any vendor not on the list. Amounts over $10,000 need CFO sign-off." From then on, every chat follows them without being told.

Edit instructions from the pinned entry at the top of the Files panel; changes take effect on the next message. The file cannot be deleted — clear its contents to remove the guidance.

![Editing project instructions with the approval rules](/docs/automated_screenshots/platform-projects_instructions-editor.webp)

## Files that outlive the chat

Project files hold the living data. Drag and drop `approved-vendors.csv` onto the Files panel (up to 25 MB per file) and every chat in the project can read it; when the list changes, edit `.txt` and `.md` files in place, or re-upload — a name collision appends a number, an upload never overwrites an existing file. Files the agent saves (`save_file`, `download_file`) land in the project too, so outputs like `invoice-report-2026-06.md` accumulate where everyone with access can reach them, instead of staying scoped to the chat that produced them.

![Project files: the vendor list and an agent-written monthly report](/docs/automated_screenshots/platform-projects_files-panel.webp)

## Reports that write themselves: schedules

A schedule runs an agent on a cron schedule (with a timezone, defaulted to your browser's), scoped to the project. Pick the agent and write the task prompt — here: on the 1st of each month, pull last month's approvals through the accounting MCP server and save the report to project files. Each run executes under the permissions of the user who created the schedule, starts a chat in the project marked as a scheduled run, and preserves the full conversation — open it to review what the agent did, and continue chatting in the same context.

![New schedule dialog filled in for the monthly invoice report](/docs/automated_screenshots/platform-projects_schedule-dialog.webp)

## Share with the team

A project is private until shared — with selected teams or the whole organization. Share "Vendor Invoice Approvals" with the Finance team and everyone on it reads the same chats, starts their own, and works with the same vendor list and reports; nobody approves against a stale copy. Mutations to the project itself (rename, description, sharing, deletion) stay owner-only. Deleting a project keeps its chats as ordinary conversations but removes its files and schedules.

![Sharing the project with the Finance team](/docs/automated_screenshots/platform-projects_sharing-dialog.webp)

## Administration

The projects list has a scope filter over share visibility — **Personal**, **Team**, or **Organization** — and `project:admin` holders can use it to reach other members' projects. That permission is additive oversight: it covers the project and its files, never its chats. See [Access Control](./platform-access-control) for configuring it alongside the standard `project` and `scheduledTask:admin` permissions.
