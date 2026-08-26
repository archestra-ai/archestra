---
title: MCP Apps
category: Apps
order: 1
description: User-authored MCP Apps — sandboxed HTML interfaces with their own data store and tools
lastUpdated: 2026-08-26
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

MCP Apps are interactive interfaces authored inside Archestra. An app is an HTML document that runs in a hardened sandbox iframe and talks to the host only through tools. Apps are first-class, scoped entities — created from chat or the `/apps` page, versioned on every edit, runnable standalone or inside a conversation, and governed by the same personal/team/org RBAC as agents and skills.

Archestra already hosts and renders MCP Apps served by external MCP servers. This feature adds the authoring side: apps you own, backed by a data store and your own assignable tools, deliberately decoupled from agents.

## Authoring and running

Authoring is a staged flow — each tool's result points at the next step:

- `refine_app` clarifies what to build. It asks the user up to three questions and records a spec, grounded in the MCP tools that user can assign.
- `scaffold_app` seeds the app from one opinionated starter template.
- `edit_app` builds up the HTML with targeted string replacements.
- `validate_app` checks the result — static structure plus the diagnostics from a live render.
- `publish_app` promotes a personal app to a team or the organization.

Editing the HTML forks a new immutable version, and the head version is served when the app runs. The procedure and the SDK conventions live in the built-in **build-app** skill, not in the tool descriptions, so the model loads them on demand.

Run or author an app at `/a/:slug` (no chat chrome, no sidebar), or run it from chat: a successful `scaffold_app`, `edit_app`, or `render_app` call renders the app inline in the conversation. All surfaces drive the same app-bound runtime, so behavior is identical. Because every owned app is backed by its own MCP server, its server settings — visibility (sharing), environment, assigned tools, and deletion — are managed from its card in the [MCP registry](./platform-mcp), not the authoring page.

## Who Can Use an App

App settings offers four choices under "Who can use this app". **Personal** keeps it to you. **Users** shares it with people you name — a colleague, for example. **Teams** shares it with whole teams. **Organization** opens it to everyone.

Sharing a chat does not share the apps it renders. Each viewer resolves an app against that app's own visibility. An app you have not shared with someone shows an access message in their view — a personal app in a chat you shared, for example. The chat's share dialog warns you when this will happen, and names the apps, so you can share them with the same people first.

Disabling an app (in App settings) pulls it back without deleting it. It leaves everyone else's gallery, and its launch tool leaves every agent surface. To chat, a disabled app does not exist: it is not listed, and no conversation can read, edit, publish, or delete it — not even yours. You still see it in your own gallery, marked Disabled; enable it there to keep building.

The `/apps` gallery lists everything the viewer can reach in two sections: apps you own, and the interactive apps exposed by your installed external [MCP servers](./platform-mcp). Each `ui://` resource is its own card, titled by the server's display name (*Task Tracker*); when one server exposes several UIs, the title carries the tool — *Task Tracker / show_board*. A card opens the app in a new chat. That chat stays out of your conversation list until you write into it. An owned card carries **Open in new tab** and **Delete** in its overflow menu; an external card carries **Open in new tab** (the standalone runtime) and a link to the backing **MCP server** page (where the server — and its uninstall — lives).

While the feature is enabled, newly created agents get the full app tool set assigned by default — the staged flow (`refine_app`, `scaffold_app`, `read_app`, `edit_app`, `validate_app`, `publish_app`) plus the supporting `preview_app_tool`, `get_app_diagnostics`, `render_app`, `list_apps`, and `delete_app` — so "build me an app" works in chat without per-agent setup. The tools can be unassigned per agent like any other; agents created before the feature was enabled need them assigned manually.

## Fullscreen

An app can fill the page instead of sitting next to the conversation. The control is on every surface that frames an app — the hover bar over an inline app, and the top bar of the right panel. Press it again, or Escape, to go back.

Fullscreen covers the page, not the whole window. The sidebar stays where it is; collapse it yourself if you want the extra width.

Set **Opens in** to *Fullscreen* in App settings and the app arrives that way every time — for a dashboard you open to read, not to talk to. It is a starting point, not a lock: leaving fullscreen keeps you out of it for the rest of that view.

## Locking an App

A locked app is immutable. Agents refuse every change to it — edits, tool assignments, deletion — until it is unlocked. Viewing and running are unaffected. An agent may unlock an app only when you directly ask it to; it never unlocks one on its own. Lock or unlock an app in App settings, or ask an agent in chat.

## Defaults for New Apps

Two settings in **Settings → Apps** govern how new apps start. Both are off by default. Flipping them never touches existing apps.

**New apps are disabled by default** creates every new app disabled. The app stays author-only and cannot be run until you enable it in App settings.

**New apps are locked by default** creates every new app [locked](#locking-an-app).

Under either setting, the chat that created the app can finish building it. A new app never arrives frozen as an empty shell — you enable or unlock a finished app, not a starter template. Every other chat meets the setting from the app's first moment, and a disabled app is not even acknowledged there. Locking or disabling the app yourself ends that one exception.

## Icons

Give an app an icon in App settings — an emoji, or an image you upload. It shows wherever the app does: the `/apps` gallery, the pinned list in the sidebar, and the pill that opens it in chat. Without one, the app keeps the generic app glyph.

An app and its backing MCP server share one icon, so setting it in App settings also sets it on the server's page in the [MCP registry](./platform-mcp).

An agent can pick an icon when it scaffolds an app, so an app built in chat usually arrives with one.

## Labels

Labels are key-value tags that organize your apps — `env: prod`, for example. You add them in App settings.

The `/apps` gallery filters by label. Pick a key, then the values you want. Choosing values under two keys narrows the list to apps carrying both. Choosing several values under one key widens it to apps carrying any of them.

Apps from installed MCP servers show their server's labels, so one filter covers the whole gallery. You edit those on the server's page in the [MCP registry](./platform-mcp).

Agents can read and set labels through the built-in app tools, so you can ask one in chat to tag an app.

## External MCP clients

An owned app is also a standalone MCP server at `POST /api/mcp/app/:id`. An external MCP client (for example a desktop MCP host) connects there with a **user (personal) token**, which resolves to a concrete viewer; organization/team tokens are rejected, because an app needs a viewer for its per-user store and RBAC. The connection binds the app from the route, so the client speaks ordinary MCP: `tools/list` exposes the app's assigned tools, its data-store tools, and an `open` tool whose result carries the app's `ui://` resource; `resources/read` returns the app's HTML. Tool calls reuse the connecting token for upstream MCP servers, exactly as in-app calls do — so an app behaves the same whether driven from Archestra or another client.

To render the UI in a foreign host, the served HTML is self-contained (absolute asset URLs, host-agnostic SDK bootstrap), so a host that implements MCP-UI (`io.modelcontextprotocol/ui`) can render it; set `ARCHESTRA_API_BASE_URL` so those asset URLs resolve. The platform CSP travels with the resource as a `<meta>` tag, but a foreign host ultimately controls its own iframe — Archestra's network lockdown is enforced on Archestra's surfaces, and the [shared-app trust boundary](#shared-app-trust-boundary) applies in full when an app runs elsewhere.

## The Apps SDK

An app's HTML is pure UI authored against the **Archestra Apps SDK** — a client microframework the platform injects at serve time as `window.archestra` (the stored HTML never contains it). Apps carry no SDK imports or postMessage wiring — and must not add any: HTML that bootstraps the connection itself, or loads the SDK script on its own, is rejected on save, because a second connection would race the injected one.

The SDK:

- `archestra.user` — the authenticated viewer as `{ id, name }`. There is no login flow to build: whoever is signed in and opens the app *is* the user.
- `archestra.storage.user.get(key)` / `set(key, value)` / `list()` / `delete(key)` — persistent storage **private to each viewer** (favorites, drafts, settings). The right default for almost all app state. Values are plain JSON: pass objects directly to `set` and `get` returns exactly what was stored (`null` when absent) — no `JSON.stringify`/`JSON.parse` round-trip. Top-level `null` itself is not storable (`set` rejects it; `delete` clears a key). `list()` returns `[{ key, value }]` entries, not an array of keys.
- `archestra.storage.shared.*` — same methods against one store **shared by every user of the app** (leaderboards, collaborative lists).
- `archestra.tools.call(name, args)` — call an assigned tool **as the viewing user, with their existing MCP credentials** (see Tools below). Resolves with the tool's data directly: `structuredContent` when the tool provides it, else JSON parsed from its text output, else the raw text, else `{ media: [{ type, mimeType, dataUrl }] }` for image/audio-only results (the `dataUrl` drops straight into an `img`/`audio` src), else `null`. When the tool's server still needs connecting, the call rejects with a typed `{ code: "auth_required", url }` error the app can render as a link.
- `archestra.tools.list()` — the app's assigned tools with their schemas.
- `archestra.llm.complete(prompt, { system, jsonMode })` — run **one** host LLM completion as the viewer and resolve to the model's text, for summarizing, classifying, extracting, or generating over data the app already has. The model is the organization's configured one (the app cannot choose it); the call runs through the LLM proxy so it counts against the viewer's usage limits and is recorded like any other interaction. `jsonMode` steers the model to return a single JSON value (the app still `JSON.parse`s it). It rejects with a typed `{ code: "llm_quota" }` when limits are reached, or `{ code: "llm_unavailable" }` otherwise. It is **not** a data source — it cannot fetch anything; all external data still comes through assigned tools. `archestra.llm.prompt\`…\`` is a tagged-template helper that builds a prompt string.
- `archestra.ui.openLink(url)`, `archestra.ui.requestDisplayMode(mode)` — host features: open an external link, switch inline/fullscreen.
- `archestra.ready` — a promise resolving when the host connection is up.

All methods are async and usable immediately — the SDK connects to the host on load. Saves also validate structure softly: a document without `<head>`/`<html>` saves with a warning returned in the response.

## Styling

The platform injects a baseline stylesheet at serve time, leading the cascade so any app CSS that follows overrides it (it is never stored, like the SDK, and must not be `<link>`ed by the app itself — that is rejected on save). It provides:

- **Theme variables** with light/dark (`prefers-color-scheme`): `--color-text-primary`, `--color-text-secondary`, `--color-text-danger`, `--color-text-inverse`, `--color-background-primary`, `--color-background-secondary`, `--color-background-inverse`, `--color-border-primary`, `--color-accent`, `--border-radius-sm/md/lg`, `--font-sans`, `--font-mono`.
- **Themed element defaults** for `body`, headings, `p`, links, lists, `button`, and `input`/`textarea`/`select`.
- **`.arch-*` components**: `.arch-card`, `.arch-btn` (`--primary`, `--ghost`), `.arch-input`, `.arch-tabs`/`.arch-tab`, `.arch-badge`, `.arch-spinner`.

Write only app-specific CSS — never a full theme. The CDN allowlist is for client-side libraries (charts, markdown renderers), not stylesheets.

## Render diagnostics

Every inline render of an owned app is observed: runtime errors (`window.onerror`, unhandled rejections, `console.error`) and CSP violations are captured from the sandbox, capped and deduplicated, and shown as an error badge on the app card. When the user sends their next chat message, the captured diagnostics are attached to it so the model can fix the app via `edit_app` without the user pasting errors by hand.

As a render settles, the host page also posts a snapshot (the captured entries, or an empty snapshot meaning "rendered clean") to the server, keyed per `(app, viewer)`. The `get_app_diagnostics` tool reads it back, so an authoring agent can observe a render **within the same turn** instead of waiting for the user's next message — it returns `clean`, `errors` (with the diagnostics), or `no_render_observed`, briefly waiting for the current version to render. Diagnostics originate inside the untrusted app iframe, so wherever they reach the model — the next-message attachment or the tool — they are framed strictly as data, never as instructions.

## Authoring loop

The app tools form an autonomous build→render→fix loop, so an agent rarely needs the human in the middle of a build: `scaffold_app` → `edit_app` to build up the HTML → the app renders inline → `get_app_diagnostics` to see what broke → `edit_app` to fix. `read_app` returns the current stored HTML when it is not in context, and `edit_app` applies small `str_replace` edits instead of re-streaming the whole document. When app code must parse a tool's output, `preview_app_tool` runs one of the app's assigned tools server-side (as the viewer, with their credentials) and returns its real shape — but it requires human approval each call, since the tool was granted to the app, not the agent (so it is blocked outright in autonomous A2A/Slack contexts).

## App Data Store

Each app has its own key-to-document store, exposed to the app's HTML as `archestra.storage`. The store is **partitioned**: `storage.user` addresses a partition private to the viewing user (the user is taken from the authenticated session, never from the app), and `storage.shared` addresses one app-wide partition all users share. No app id is ever passed: the app's MCP endpoint is route-bound, so an app can only ever read and write its own store. Access is gated by the viewing user's RBAC — reads need `app:read`, writes need `app:update`.

## App Files

An app can also keep files. Its HTML works with them through `archestra.files`: `list()` names the files, `read()` returns a browser `File`, `save()` writes one, `delete()` removes one. `read` returns exact bytes whatever the type — the way a program opens a 3D model or PDF it saved earlier. `save` replaces a same-named file by default. The lower-level built-in file tools stay callable through `archestra.tools.call` — `archestra__read_file` for a paged text window, `archestra__edit_file` for in-place edits, plus `archestra__upload_file` and `archestra__download_file` for the app's own execution sandbox.

The file store is private to each viewer of the app. Two people using the same app never see each other's files, and an app never sees a chat's or a project's files. The store is the same wherever the app runs — inline in chat, on its standalone page, or in an external MCP client — so a document the app writes is there on the next visit. The app's sandbox is scoped the same way, so what an app does never clutters the sandbox of a conversation, another app, or another viewer.

Agents read the same store through `archestra__read_file`'s paged text window; the raw-bytes read exists only inside app runtimes.

Use files for documents the app produces or the viewer keeps — a generated report, for example. Use the data store for structured state like settings and records.

An agent moves files between a chat and the app you have open there. Ask it to open a file in the app, and it copies the file across — an attachment, or something from the chat's Files panel. The copy keeps its own filename, so the app finds it by listing its files and opening that name. Copies go the other way too: a file the app made lands in your Files panel, ready to download.

An app that opens viewer files should offer a picker — a dropdown filled from `files.list()`. The app subscribes to `files.onChange` to refresh it: a file you just generated in chat shows up the moment the agent copies it across, with no refresh button.

The agent knows the open app's files too. Each turn lists them in its context, and the app reports what it is showing — automatically on `files.read`, or explicitly via `archestra.ui.updateModelContext`. Ask about "this file" in chat and the agent knows which one you mean.

An app's files are all an agent can see of it. It lists them to find what the app has produced, and it cannot observe what the app is showing you or doing. Name the file you want, and it copies that one.

Reads need `file:manage`, and the transfer tools need `sandbox:execute`. The file tools require the sandbox runtime; deployments that run without it have no file store.

## Tools and auto-auth

Beyond the data store, an app can be assigned upstream MCP-server tools — from the Tools tab of its settings in the MCP registry, or directly from chat via the `tools` parameter of `scaffold_app` (declarative: the list replaces the current assignments). Assignment mirrors the agent model (scope-aligned, dynamic credentials by default). A running app can call only its assigned tools plus its own data-store tools; everything else is refused at the route. A new app binds to the [environment](./platform-environments) of the agent that builds it — the authoring agent for `scaffold_app`, the chat agent an app created on the Apps page opens with. With no such agent it lands in the organization's landing environment for new apps. Assignable tools are that environment's plus the Default environment's.

Tool calls run **as the viewing user**: the platform resolves the MCP server and credentials per viewer at call time (personal install first, then team, then org), so an app reuses whatever MCP servers the viewer has already connected — no tokens in app code, no per-app auth setup. If the viewer hasn't connected the required server yet, `archestra.tools.call` rejects with `{ code: "auth_required", url }`; the user completes authentication in the MCP registry (apps cannot run OAuth flows themselves) and the next call succeeds.

## Network lockdown

Apps are MCP wrappers, and their CSP is not author-controlled: every owned app renders under one platform-pinned policy. Direct network access is blocked entirely (`connect-src 'none'`) — `fetch`, XHR, and WebSockets to external APIs fail, so assigned MCP tools (governed, authed, audited) are the only data egress. The single external allowance is static assets: scripts, styles, fonts, and images may load from a hardcoded CDN allowlist (`cdn.jsdelivr.net`, `unpkg.com`, `cdnjs.cloudflare.com`, `fonts.googleapis.com`, `fonts.gstatic.com`) so apps can use client-side libraries. Note the trust implication: a CDN-loaded script runs inside the app and can call its assigned tools as the viewer — prefer pinned versions of well-known packages. A future release may make the allowlist configurable per organization.

## Device permissions

An app can declare `camera`, `microphone`, `geolocation`, or `clipboardWrite` in its UI permissions to reach the matching browser API; each is delegated to the sandbox via Permissions-Policy and still prompts the viewer for consent at first use. These features require the sandbox to run on a dedicated origin (a configured sandbox domain, or the `localhost`/`127.0.0.1` split in local dev). On the same-origin fallback the sandbox is an opaque origin, which browsers cannot grant powerful features to, so these requests are blocked regardless of the declaration.

## Shared-app trust boundary

A shared (team or org) app is author-written HTML executing in a viewer's browser. The viewer is protected by three layers: the HTML runs in an isolated sandbox iframe; its network access is blocked by the platform CSP (MCP tools are the only data path); and every tool and data-store call is gated by the **viewing** user's RBAC, not the author's. Note the converse too: the app's code sees the viewer's id and display name (`archestra.user`), and tool calls it makes run with the viewer's credentials. Share apps only with people you would grant the app's tool and data access.

## Templates

A single `default` starter seeds a new app's HTML when no explicit HTML is given on create: a themed empty state that centers the app's name, a prompt-only call to action, and a short list of what an app can build on (assigned MCP tools, the per-user and shared data store, built-in AI). It leans on the injected baseline stylesheet, so it looks themed with no full theme of its own. Resolution is server-side — `POST /api/apps` (with an optional `templateId`) or `scaffold_app` seeds the starter's HTML as version 1, substituting the app's name (the id is kept as provenance). The starter's mark follows your branding: when the organization has a logo configured in appearance settings, new apps seed with that logo instead of the Archestra mark. Explicit HTML always wins over the template.
