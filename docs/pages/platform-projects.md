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

A project is a shared workspace for your chats, files, instructions, and scheduled tasks. Everything saved in a project is available to everyone in it. Projects are private until you share them with teams or the whole organization.

![A project with its chats, files, and monthly schedule](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a Project

Start a project from the Projects page, or turn an existing chat into one with **Create project** in the chat's menu — the chat and its files move right in.

![Chat sidebar menu with the Create project action](/docs/automated_screenshots/platform-projects_create-from-chat.webp)

## Files

When an agent saves a file in a project chat — a report, for example — it goes to the project. The project page lists them all, and every chat in the project can read them.

You can add your own files too: drag and drop them onto the Files panel. Text and Markdown files are editable right in the panel.

Every project has an `instructions.md` file, pinned at the top of the Files panel. Write the rules once, and every chat in the project follows them.

![Editing project instructions](/docs/automated_screenshots/platform-projects_instructions-editor.webp)

## Scheduled Tasks

A schedule runs an agent for you on a recurring basis. Every run is saved as a chat in the project, so you can always see what the agent did.

![New schedule dialog](/docs/automated_screenshots/platform-projects_schedule-dialog.webp)

## Use Case: Vendor Invoice Approvals

A finance person approves incoming invoices against the company's vendor list. A monthly report is generated automatically:

- **Files**: `approved-vendors.csv`, uploaded once and edited as vendors change, plus the reports the agent writes.
- **Instructions**: "Match every invoice against approved-vendors.csv. Flag any vendor not on the list. Amounts over $10,000 need CFO sign-off."
- **Chats**: the daily work — "check this invoice from Acme GmbH". Every chat follows the instructions and can read the vendor list.
- **A schedule**: on the 1st of each month, an agent collects last month's approvals and saves a report into the project files.
- **Sharing** with the Finance team: everyone approves against the same list and reads the same reports.

![Sharing the project with the Finance team](/docs/automated_screenshots/platform-projects_sharing-dialog.webp)

Everyone with access to a shared project can read its chats, start their own, and work with its files. Deleting a project keeps the chats but removes the files and schedules. See [Access Control](./platform-access-control) for permissions.
