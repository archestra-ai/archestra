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

A project is a shared workspace for chats, files, instructions, and scheduled tasks. Files saved in a project are available to everyone in it. A project is private until you share it with teams or the whole organization.

![A project with its chats, files, and monthly schedule](/docs/automated_screenshots/platform-projects_project-overview.webp)

## Creating a Project

Create a project from the Projects page, or turn an existing chat into one with **Create project** in the chat's sidebar menu. The chat and its files move into the new project.

![Chat sidebar menu with the Create project action](/docs/automated_screenshots/platform-projects_create-from-chat.webp)

## Files

Files the agent saves go to the project. You can also drag and drop your own files onto the Files panel. Text and Markdown files can be edited in place.

![Project files listed next to the project's chats](/docs/automated_screenshots/platform-projects_files-panel.webp)

Every project has an `instructions.md` file, pinned at the top of the Files panel. Write the rules once, and every chat in the project follows them.

![Editing project instructions](/docs/automated_screenshots/platform-projects_instructions-editor.webp)

## Scheduled Tasks

A schedule runs an agent on a recurring basis. Pick an agent, write a task prompt, and choose how often it runs. Every run is saved as a chat in the project, so you can review what the agent did.

![New schedule dialog](/docs/automated_screenshots/platform-projects_schedule-dialog.webp)

## Use Case: Vendor Invoice Approvals

A finance person approves incoming invoices against the company's vendor list, and a monthly report generates itself:

- **Files**: `approved-vendors.csv`, uploaded once and edited as vendors change, plus the reports the agent writes.
- **Instructions**: "Match every invoice against approved-vendors.csv. Flag any vendor not on the list. Amounts over $10,000 need CFO sign-off."
- **Chats**: the daily work — "check this invoice from Acme GmbH". Every chat follows the instructions and can read the vendor list.
- **A schedule**: on the 1st of each month, an agent collects last month's approvals and saves a report into the project files.
- **Sharing** with the Finance team: everyone approves against the same list and reads the same reports.

![Sharing the project with the Finance team](/docs/automated_screenshots/platform-projects_sharing-dialog.webp)

Everyone with access to a shared project can read its chats, start their own, and work with its files. Only the owner can change or delete the project. Deleting it keeps the chats but removes the files and schedules. See [Access Control](./platform-access-control) for permissions.
