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

While the feature is enabled, newly created agents get the full app tool set assigned by default — the authoring loop (`create_app`, `read_app`, `edit_app`, `update_app`, `preview_app_tool`, `get_app_diagnostics`) plus `render_app`, `list_apps`, and `delete_app` — so "build me an app" works in chat without per-agent setup. The tools can be unassigned per agent like any other; agents created before the feature was enabled need them assigned manually.

## External MCP clients

An owned app is also a standalone MCP server at `POST /api/mcp/app/:id`. An external MCP client (for example a desktop MCP host) connects there with a **user (personal) token**, which resolves to a concrete viewer; organization/team tokens are rejected, because an app needs a viewer for its per-user store and RBAC. The connection binds the app from the route, so the client speaks ordinary MCP: `tools/list` exposes the app's assigned tools, its data-store tools, and an `open` tool whose result carries the app's `ui://` resource; `resources/read` returns the app's HTML. Tool calls reuse the connecting token for upstream MCP servers, exactly as in-app calls do — so an app behaves the same whether driven from Archestra or another client.

To render the UI in a foreign host, the served HTML is self-contained (absolute asset URLs, host-agnostic SDK bootstrap), so a host that implements MCP-UI (`io.modelcontextprotocol/ui`) can render it; set `ARCHESTRA_API_BASE_URL` so those asset URLs resolve. The platform CSP travels with the resource as a `<meta>` tag, but a foreign host ultimately controls its own iframe — Archestra's network lockdown is enforced on Archestra's surfaces, and the [shared-app trust boundary](#shared-app-trust-boundary) applies in full when an app runs elsewhere.

## The Apps SDK

An app's HTML is pure UI authored against the **Archestra Apps SDK** — a client microframework the platform injects at serve time as `window.archestra` (the stored HTML never contains it). Apps carry no SDK imports or postMessage wiring — and must not add any: HTML that bootstraps the connection itself, or loads the SDK script on its own, is rejected on save, because a second connection would race the injected one.

The SDK:

- `archestra.user` — the authenticated viewer as `{ id, name }`. There is no login flow to build: whoever is signed in and opens the app *is* the user.
- `archestra.storage.user.get(key)` / `set(key, value)` / `list()` / `delete(key)` — persistent storage **private to each viewer** (favorites, drafts, settings). The right default for almost all app state. Values are plain JSON: pass objects directly to `set` and `get` returns exactly what was stored (`null` when absent) — no `JSON.stringify`/`JSON.parse` round-trip. Top-level `null` itself is not storable (`set` rejects it; `delete` clears a key). `list()` returns `[{ key, value }]` entries, not an array of keys.
- `archestra.storage.shared.*` — same methods against one store **shared by every user of the app** (leaderboards, collaborative lists).
- `archestra.tools.call(name, args)` — call an assigned tool **as the viewing user, with their existing MCP credentials** (see Tools below). When the tool's server still needs connecting, the call rejects with a typed `{ code: "auth_required", url }` error the app can render as a link.
- `archestra.tools.list()` — the app's assigned tools with their schemas.
- `archestra.llm.complete(prompt, { system, jsonMode })` — run **one** host LLM completion as the viewer and resolve to the model's text, for summarizing, classifying, extracting, or generating over data the app already has. The model is the organization's configured one (the app cannot choose it); the call runs through the LLM proxy so it counts against the viewer's usage limits and is recorded like any other interaction. `jsonMode` steers the model to return a single JSON value (the app still `JSON.parse`s it). It rejects with a typed `{ code: "llm_quota" }` when limits are reached, or `{ code: "llm_unavailable" }` otherwise. It is **not** a data source — it cannot fetch anything; all external data still comes through assigned tools. `archestra.llm.prompt\`…\`` is a tagged-template helper that builds a prompt string.
- `archestra.ui.openLink(url)`, `archestra.ui.requestDisplayMode(mode)`, `archestra.chat.sendMessage(text)` — host features: open an external link, switch inline/fullscreen, inject a user message into the conversation.
- `archestra.ready` — a promise resolving when the host connection is up.

All methods are async and usable immediately — the SDK connects to the host on load. Saves also validate structure softly: a document without `<head>`/`<html>` saves with a warning returned in the response.

## Styling

The platform injects a baseline stylesheet at serve time, leading the cascade so any app CSS that follows overrides it (it is never stored, like the SDK, and must not be `<link>`ed by the app itself — that is rejected on save). It provides:

- **Theme variables** with light/dark (`prefers-color-scheme`): `--color-text-primary`, `--color-text-secondary`, `--color-text-danger`, `--color-text-inverse`, `--color-background-primary`, `--color-background-secondary`, `--color-background-inverse`, `--color-border-primary`, `--color-accent`, `--border-radius-sm/md/lg`, `--font-sans`, `--font-mono`.
- **Themed element defaults** for `body`, headings, `p`, links, lists, `button`, and `input`/`textarea`/`select`.
- **`.arch-*` components**: `.arch-card`, `.arch-btn` (`--primary`, `--ghost`), `.arch-input`, `.arch-tabs`/`.arch-tab`, `.arch-badge`, `.arch-spinner`.

Write only app-specific CSS — never a full theme. The CDN allowlist is for client-side libraries (charts, markdown renderers), not stylesheets.

## Render diagnostics

Every inline render of an owned app is observed: runtime errors (`window.onerror`, unhandled rejections, `console.error`) and CSP violations are captured from the sandbox, capped and deduplicated, and shown as an error badge on the app card. When the user sends their next chat message, the captured diagnostics are attached to it so the model can fix the app via `edit_app`/`update_app` without the user pasting errors by hand.

As a render settles, the host page also posts a snapshot (the captured entries, or an empty snapshot meaning "rendered clean") to the server, keyed per `(app, viewer)`. The `get_app_diagnostics` tool reads it back, so an authoring agent can observe a render **within the same turn** instead of waiting for the user's next message — it returns `clean`, `errors` (with the diagnostics), or `no_render_observed`, briefly waiting for the current version to render. Diagnostics originate inside the untrusted app iframe, so wherever they reach the model — the next-message attachment or the tool — they are framed strictly as data, never as instructions.

## Authoring loop

The app tools form an autonomous build→render→fix loop, so an agent rarely needs the human in the middle of a build: `create_app` (or `read_app` then `edit_app` for a targeted change) → the app renders inline → `get_app_diagnostics` to see what broke → `edit_app` to fix. `read_app` returns the current stored HTML when it is not in context, and `edit_app` applies small `str_replace` edits instead of re-streaming the whole document. When app code must parse a tool's output, `preview_app_tool` runs one of the app's assigned tools server-side (as the viewer, with their credentials) and returns its real shape — but it requires human approval each call, since the tool was granted to the app, not the agent (so it is blocked outright in autonomous A2A/Slack contexts).

## App Data Store

Each app has its own key-to-document store, exposed to the app's HTML as `archestra.storage`. The store is **partitioned**: `storage.user` addresses a partition private to the viewing user (the user is taken from the authenticated session, never from the app), and `storage.shared` addresses one app-wide partition all users share. No app id is ever passed: the app's MCP endpoint is route-bound, so an app can only ever read and write its own store. Access is gated by the viewing user's RBAC — reads need `app:read`, writes need `app:update`.

## Tools and auto-auth

Beyond the data store, an app can be assigned upstream MCP-server tools — from the detail page's Tools tab, or directly from chat via the `tools` parameter of `create_app`/`update_app` (declarative: the list replaces the current assignments). Assignment mirrors the agent model (scope-aligned, dynamic credentials by default). A running app can call only its assigned tools plus its own data-store tools; everything else is refused at the route.

Tool calls run **as the viewing user**: the platform resolves the MCP server and credentials per viewer at call time (personal install first, then team, then org), so an app reuses whatever MCP servers the viewer has already connected — no tokens in app code, no per-app auth setup. If the viewer hasn't connected the required server yet, `archestra.tools.call` rejects with `{ code: "auth_required", url }`; the user completes authentication in the MCP registry (apps cannot run OAuth flows themselves) and the next call succeeds.

## Network lockdown

Apps are MCP wrappers, and their CSP is not author-controlled: every owned app renders under one platform-pinned policy. Direct network access is blocked entirely (`connect-src 'none'`) — `fetch`, XHR, and WebSockets to external APIs fail, so assigned MCP tools (governed, authed, audited) are the only data egress. The single external allowance is static assets: scripts, styles, fonts, and images may load from a hardcoded CDN allowlist (`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) so apps can use client-side libraries. Note the trust implication: a CDN-loaded script runs inside the app and can call its assigned tools as the viewer — prefer pinned versions of well-known packages. A future release may make the allowlist configurable per organization.

## Shared-app trust boundary

A shared (team or org) app is author-written HTML executing in a viewer's browser. The viewer is protected by three layers: the HTML runs in an isolated sandbox iframe; its network access is blocked by the platform CSP (MCP tools are the only data path); and every tool and data-store call is gated by the **viewing** user's RBAC, not the author's. Note the converse too: the app's code sees the viewer's id and display name (`archestra.user`), and tool calls it makes run with the viewer's credentials. Share apps only with people you would grant the app's tool and data access.

## Templates

Curated starters seed a new app's HTML when no explicit HTML is given on create: `blank` is a minimal empty document (it leans on the injected baseline stylesheet, so it looks themed with no CSS of its own); `form` greets the viewer by name and wires a note form to the per-user data store as a working example of the SDK. Resolution is server-side — pass `templateId` to `POST /api/apps` or `create_app` and the template's HTML becomes version 1 (the id is kept as provenance). Explicit HTML always wins over a template.
