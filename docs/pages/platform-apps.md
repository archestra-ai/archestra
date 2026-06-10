---
title: MCP Apps
category: Apps
order: 1
description: User-authored MCP Apps — sandboxed HTML interfaces with their own data store and tools
lastUpdated: 2026-06-10
---

<!--
Check ../docs_writer_prompt.md before changing this file.
-->

MCP Apps are interactive interfaces authored inside Archestra. An app is an HTML document that runs in a hardened sandbox iframe and talks to the host only through tools. Apps are first-class, scoped entities — created from chat or the `/apps` page, versioned on every edit, runnable standalone or inside a conversation, and governed by the same personal/team/org RBAC as agents and skills.

Archestra already hosts and renders MCP Apps served by external MCP servers. This feature adds the authoring side: apps you own, backed by a data store and your own assignable tools, deliberately decoupled from agents.

Ships behind `ARCHESTRA_APPS_ENABLED` (off by default). See [Deployment](./platform-deployment).

## Authoring and running

Create an app from a starter template (the HTML seed) and a name. Editing the HTML forks a new immutable version; the head version is served when the app runs. Run an app standalone at `/apps/:id/run` (no chat chrome), or from chat: a successful `create_app`, `update_app`, or `render_app` call renders the app inline in the conversation. Both surfaces drive the same app-bound runtime, so behavior is identical.

## App runtime contract

An app's HTML is pure UI. The platform injects `window.archestra` into every owned app at serve time (the stored HTML never contains it), so apps carry no SDK imports or postMessage wiring — and must not add any: HTML that bootstraps the MCP App SDK itself is rejected on save, because a second connection would race the injected one.

The injected API:

- `window.archestra.data.get(key)` / `set(key, value)` / `list()` / `delete(key)` — the App Data Store.
- `window.archestra.callTool(name, args)` — call the app's assigned tools (see Tools below).
- `window.archestra.openLink(url)`, `requestDisplayMode(mode)`, `sendMessage(text)` — host features: open an external link, switch inline/fullscreen, inject a user message into the conversation.

All methods are async and usable immediately — the runtime connects to the host on load. Saves also validate structure softly: a document without `<head>`/`<html>` saves with a warning returned in the response.

## Render diagnostics

Every inline render of an owned app is observed: runtime errors (`window.onerror`, unhandled rejections, `console.error`) and CSP violations are captured from the sandbox, capped and deduplicated, and shown as an error badge on the app card. When the user sends their next chat message, the captured diagnostics are attached to it so the model can fix the app via `update_app` without the user pasting errors by hand. Diagnostics originate inside the untrusted app iframe, so the prompt frames them strictly as data, never as instructions.

## App Data Store

Each app has its own key-to-document store, exposed to the app's HTML as `window.archestra.data.get/set/list/delete`. No app id is ever passed: the app's MCP endpoint is route-bound, so an app can only ever read and write its own store. Access is gated by the viewing user's RBAC — reads need `app:read`, writes need `app:update`.

## Tools

Beyond the data store, an app can be assigned upstream MCP-server tools from the detail page's Tools tab. Assignment mirrors the agent model (scope-aligned, dynamic credentials by default). A running app can call only its assigned tools plus its own data-store tools; everything else is refused at the route.

## Shared-app trust boundary

A shared (team or org) app is author-written HTML executing in a viewer's browser. The viewer is protected by three layers: the HTML runs in an isolated sandbox iframe; its network access is restricted to a validated `connect-src` allowlist; and every tool and data-store call is gated by the **viewing** user's RBAC, not the author's. Share apps only with people you would grant the app's tool and data access.

## Templates

Curated starters seed a new app's HTML when no explicit HTML is given on create: `blank` is a styled empty document; `form` wires a note form to the App Data Store as a working example of the runtime API. Resolution is server-side — pass `templateId` to `POST /api/apps` or `create_app` and the template's HTML becomes version 1 (the id is kept as provenance). Explicit HTML always wins over a template.
