---
title: Projects
category: Agents
order: 3
description: Organize chats, instructions, and context around a shared workstream
lastUpdated: 2026-06-09
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

Projects group related agent chats around a named workstream. A project can define shared instructions, attach knowledge sources, and keep recent sessions in one place while still allowing normal chats outside any project.

## What Belongs To A Project

A project includes:

- Name, description, and icon
- Project instructions appended to chats started in that project
- Visibility: personal, selected teams, or organization-wide
- Knowledge sources used as project context
- Related chat sessions
- Scheduled triggers associated with that project

Project instructions should describe stable rules for the workstream: terminology, tone, output format, or constraints the agent should follow. Put task-specific requests in the chat prompt instead.

## Visibility

New projects are personal by default. Personal projects are only visible to their creator. Project admins can promote a project to selected teams or to the whole organization.

Team projects are visible to members of the selected teams. Organization projects are visible to everyone in the organization.

## Chat Sessions

Chats can be created inside a project or moved into a project later. Project chats remain normal Archestra chat sessions, but they inherit project instructions and appear in the project's recent sessions list.

Chats outside a project continue to work as before and appear separately in Chat.

## Permissions

The `project` resource controls access:

- `project:read` allows listing and opening visible projects
- `project:create` allows creating personal projects
- `project:update` and `project:delete` allow managing personal projects the user owns
- `project:team-admin` allows managing team projects for teams the user belongs to
- `project:admin` allows viewing all projects and managing organization-wide visibility

Project visibility limits what a user can see even when they have `project:read`.
