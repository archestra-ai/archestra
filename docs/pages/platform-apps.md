---
title: MCP Apps
category: Apps
order: 1
description: User-authored MCP Apps — sandboxed HTML interfaces with their own data store and tools
lastUpdated: 2026-06-09
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

MCP Apps are interactive interfaces authored inside Archestra. An app is an HTML document that runs in a hardened sandbox iframe and talks to the host only through tools. Apps are first-class, scoped entities — created from chat or the `/apps` page, versioned on every edit, runnable standalone or inside a conversation, and governed by the same personal/team/org RBAC as agents and skills.

Archestra already hosts and renders MCP Apps served by external MCP servers. This feature adds the authoring side: apps you own, backed by a data store and your own assignable tools, deliberately decoupled from agents.

Ships behind `ARCHESTRA_APPS_ENABLED` (off by default). See [Deployment](./platform-deployment).

## Authoring and running

Create an app from a starter template (the HTML seed) and a name. Editing the HTML forks a new immutable version; the head version is served when the app runs. Run an app standalone at `/apps/:id/run` (no chat chrome) or open it from chat — both drive the same app-bound runtime, so behavior is identical.

## App Data Store

Each app has its own key-to-document store, exposed to the app's HTML as `window.archestra.data.get/set/list/delete`. No app id is ever passed: the app's MCP endpoint is route-bound, so an app can only ever read and write its own store. Access is gated by the viewing user's RBAC — reads need `app:read`, writes need `app:update`.

## Tools

Beyond the data store, an app can be assigned upstream MCP-server tools from the detail page's Tools tab. Assignment mirrors the agent model (scope-aligned, dynamic credentials by default). A running app can call only its assigned tools plus its own data-store tools; everything else is refused at the route.

## Shared-app trust boundary

A shared (team or org) app is author-written HTML executing in a viewer's browser. The viewer is protected by three layers: the HTML runs in an isolated sandbox iframe; its network access is restricted to a validated `connect-src` allowlist; and every tool and data-store call is gated by the **viewing** user's RBAC, not the author's. Share apps only with people you would grant the app's tool and data access.

## Templates

Curated starters seed a new app's HTML. `blank` is an empty document; `form` wires a note form to the App Data Store as a working example of the host API. Templates are static — the chosen template's HTML is copied into the app on create; the template id is kept only as provenance.
