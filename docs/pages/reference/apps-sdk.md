---
title: Apps SDK Reference
description: The window.archestra SDK, styling, security model, and authoring tools for MCP Apps
order: 3
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The HTML of an [MCP App](/docs/chat/apps) runs against the `window.archestra` SDK, the platform's injected styles, and the limits of its sandbox. Agents write apps with the built-in **Build App** skill, which follows the same rules.

## The SDK

The platform injects the SDK into every app at serve time as `window.archestra`. Do not import the SDK, load its script, or wire `postMessage` yourself: a save is rejected when the HTML sets up its own host connection.

`window.archestra` exists as soon as the page loads. Await `archestra.ready` before the first call. Every method is async except `files.onChange`, `ui.updateModelContext`, and `llm.prompt`.

```html
<script type="module">
  await archestra.ready;
  const saved = await archestra.storage.user.get("settings");
  render(saved ? saved.value : { theme: "light" });
</script>
```

### Identity and Context

- `archestra.user` - The signed-in viewer, as `{ id, name, email }`. Whoever opens the app is the user. An app needs no login flow.
- `archestra.context` - The running app, as `{ appId, version }`.

### Storage

Each app has a JSON key-value store with two partitions:

- `archestra.storage.user` - Private to each viewer. Use it for settings, drafts, and favorites.
- `archestra.storage.shared` - One store that every viewer of the app shares. Use it for shared lists and leaderboards.

Both partitions have the same methods:

| Method | Resolves to |
| --- | --- |
| `get(key)` | `{ value, revision, owner }`, or `null` when the key is absent |
| `set(key, value, opts?)` | `{ revision, owner }` |
| `list()` | `[{ key, value, revision, owner }]`, in no guaranteed order |
| `delete(key)` | nothing |

Values are plain JSON. Pass objects to `set` directly, without `JSON.stringify`. A top-level `null` cannot be stored; call `delete` to clear a key.

After a `get` or `list`, a `set` of the same key succeeds only if nobody else wrote it in between. Otherwise it rejects with `{ code: "conflict" }`; read the key again and retry. Two `set` options change this:

- `ifRevision` - Write only if the stored revision matches this number. `0` means "create, and fail if the key exists". `null` turns the check off, and the last write wins.
- `owned: true` - Claim a new shared key for the viewer. Only that viewer, the app's author, and admins can then overwrite or delete it. Other writes reject with `{ code: "forbidden" }`.

Do not use `localStorage`, `sessionStorage`, or IndexedDB. The sandbox runs the app in an opaque origin, where they throw.

### Files

`archestra.files` is a file store private to each viewer of the app. It never shows a chat's files, a project's files, or another viewer's files. The store is the same wherever the app runs: inline in chat, on its own page, or in an external MCP client. It needs the [Code Sandbox](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_ENABLED); a deployment without it has no app file store.

| Method | Does |
| --- | --- |
| `list(query?)` | Resolves to `[{ id, ref, filename, mimeType, sizeBytes, createdAt }]`. `query` filters by a filename substring. |
| `read(filename \| { id })` | Resolves to a browser `File` with the exact bytes, whatever the type. |
| `save(filename, data, opts?)` | Writes a string, `Blob`, `ArrayBuffer`, or typed array. Replaces a file of the same name unless `opts.overwrite` is `false`. `opts.mimeType` sets the type. |
| `delete(filename \| { id })` | Removes the file. |
| `onChange(listener)` | Calls `listener` when the store changes, including when an agent copies a file in from chat. Returns an unsubscribe function. The event has no payload. Call `list()` again. |

Use files for documents the app produces or the viewer keeps, such as a generated report. Use storage for structured state.

### Tools

- `archestra.tools.list()` - The tools assigned to the app, with their input schemas.
- `archestra.tools.call(name, args)` - Calls an assigned tool. Pass `name` exactly as `tools.list()` returns it, for example `github__list_issues`.

`tools.call` resolves to the first of these that the result has:

1. `structuredContent`
2. JSON parsed from the text output
3. The raw text
4. `{ media: [{ type, mimeType, dataUrl }] }` for an image-only or audio-only result. Use `dataUrl` directly as an `img` or `audio` source.
5. `null`

A tool runs as the viewer, with the viewer's own MCP credentials: their personal connection first, then their team's, then the organization's. App code holds no tokens. When the viewer has not connected the tool's MCP server yet, the call rejects with `{ code: "auth_required", url }`. Show the error message with `url` as a link. Once the viewer connects the server, the next call succeeds.

An app can call only its assigned tools and its own storage, file, and LLM methods. Assign tools from the app's **Tools** tab in the MCP Registry, or with the `tools` argument of [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app) and [`set_app_tools`](/docs/reference/archestra-mcp-server#set_app_tools). Assignable tools come from the app's [environment](/docs/admin/environments) and the Default environment.

### LLM

- `archestra.llm.complete(prompt, { system, jsonMode })` - Runs one completion as the viewer and resolves to the model's text. Use it to summarize, classify, or extract from data the app already has; it cannot fetch anything.
- `archestra.llm.prompt` - A tagged-template helper that builds a prompt string.

The completion uses the organization's configured model. The app cannot choose one. It goes through the LLM Proxy. It counts against the viewer's [usage limits](/docs/llm-proxy/costs-and-limits) and appears in the logs. With `jsonMode`, the model returns one JSON value, which the app still parses. The call rejects with `{ code: "llm_quota" }` when limits are reached, and `{ code: "llm_unavailable" }` for any other failure.

### Host UI

- `archestra.ui.openLink(url)` - Opens a link in a new tab. This is the only way to open one: the sandbox blocks popups, so `<a target="_blank">` does nothing.
- `archestra.ui.requestDisplayMode(mode)` - Switches the display. Pass `"inline"` or `"fullscreen"`.
- `archestra.ui.updateModelContext(text)` - Tells the chat model what the app is showing, in one short line ("Viewing invoice-2026.pdf, page 3"). The latest call wins. Until an app calls it, `files.read` reports the open file automatically.

### Errors

SDK calls reject with an error that carries a `code`:

| Code | Cause |
| --- | --- |
| `auth_required` | The viewer has not connected the tool's MCP server. The error carries `url`. |
| `conflict` | Another write changed the key since this instance read it. |
| `forbidden` | The shared key is owned by another viewer. |
| `llm_quota` | The viewer reached a usage limit. |
| `llm_unavailable` | The completion failed for another reason. |
| `tool_error` | A tool or file call failed. |

## Styling

The platform injects a baseline stylesheet ahead of the app's own CSS. App rules override it. Do not link it yourself: a save is rejected when the HTML does. The stylesheet provides:

- **Theme variables** that follow light and dark mode: `--color-text-primary`, `--color-text-secondary`, `--color-text-danger`, `--color-text-inverse`, `--color-background-primary`, `--color-background-secondary`, `--color-background-inverse`, `--color-border-primary`, `--color-accent`, `--border-radius-sm`, `--border-radius-md`, `--border-radius-lg`, `--font-sans`, and `--font-mono`.
- **Element defaults** for `body`, headings, `p`, links, lists, `button`, `input`, `textarea`, and `select`.
- **Components**: `.arch-card`, `.arch-btn` (with `--primary` and `--ghost`), `.arch-input`, `.arch-tabs` and `.arch-tab`, `.arch-badge`, and `.arch-spinner`.

Write only the CSS your app needs, not a full theme.

## Security Model

### Network Access

Every app renders under one platform policy; app authors cannot change it. The app has no network access: `fetch`, XHR, and WebSockets to any external address fail. Assigned MCP tools are the only way to get data in or out.

Scripts, styles, fonts, and images can load from these CDNs, so apps can use client-side libraries:

- `cdn.jsdelivr.net`
- `unpkg.com`
- `cdnjs.cloudflare.com`
- `fonts.googleapis.com`
- `fonts.gstatic.com`

A script loaded from a CDN runs inside the app and can call its tools as the viewer. Pin the versions of well-known packages.

### Device Permissions

An app can declare `camera`, `microphone`, `geolocation`, or `clipboardWrite` in its UI permissions. The browser still asks the viewer for consent on first use. These permissions work only when the sandbox has its own origin: with [`ARCHESTRA_MCP_SANDBOX_DOMAIN`](/docs/reference/configuration#ARCHESTRA_MCP_SANDBOX_DOMAIN) set, or on `localhost` in local development. Without one, the browser blocks them.

### Shared Apps

A team or organization app runs code its author wrote in each viewer's browser. Three layers protect the viewer:

- The HTML runs in an isolated sandbox iframe.
- The network policy blocks every path except assigned MCP tools.
- Every tool, storage, and file call is checked against the viewer's permissions, not the author's.

The app's code can read the viewer's name and email, and its tool calls use the viewer's credentials. Share an app only with people you would give its tool and data access.

### Permissions

Storage reads and LLM calls need [`app:read`](/docs/reference/permissions#app:read), and storage writes need `app:update`. A `use` grant on the app allows both. File calls need [`agent:read`](/docs/reference/permissions#agent:read). See [Access Control](/docs/admin/access-control).

## Authoring Tools

Agents build apps with these built-in tools. A new app created without HTML starts from a themed empty state with the app's name and the organization's logo.

| Tool | Use |
| --- | --- |
| [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app) | Creates an app, optionally with its first tool assignments. |
| [`refine_app`](/docs/reference/archestra-mcp-server#refine_app) | Records what the app should do as a spec, after asking the user up to three clarifying questions. |
| [`edit_app`](/docs/reference/archestra-mcp-server#edit_app) | Changes the HTML with targeted replacements or a full document. Each edit creates a new version. |
| [`read_app`](/docs/reference/archestra-mcp-server#read_app) | Returns the current HTML. |
| [`set_app_tools`](/docs/reference/archestra-mcp-server#set_app_tools) | Replaces the app's tool assignments. |
| [`preview_app_tool`](/docs/reference/archestra-mcp-server#preview_app_tool) | Runs one assigned tool as the viewer and returns its real output, which app code then parses. Each call needs human approval. It is unavailable in unattended runs. |
| [`validate_app`](/docs/reference/archestra-mcp-server#validate_app) | Checks the HTML without rendering it. |
| [`get_app_diagnostics`](/docs/reference/archestra-mcp-server#get_app_diagnostics) | Returns the latest render result: `clean`, `errors` with the captured errors, or `no_render_observed`. |

### Render Diagnostics

Each render captures runtime errors, unhandled rejections, `console.error` output, and policy violations from the sandbox. The app card shows an error badge. The errors are also attached to the viewer's next chat message, for the agent to fix. [`get_app_diagnostics`](/docs/reference/archestra-mcp-server#get_app_diagnostics) reads the same result within the agent's turn. A render happens only when someone opens the app.

## External MCP Clients

Each app is also an MCP server at `POST /api/mcp/app/<app-id>`. Connect an external MCP client there with a personal token; organization and team tokens are rejected, because an app needs a viewer. The client sees:

- `tools/list` - The app's assigned tools, its storage tools, and an `open` tool whose result carries the app's `ui://` resource.
- `resources/read` - The app's HTML.

Tool calls use the connecting user's credentials, as they do inside Archestra. A host that supports MCP Apps (`io.modelcontextprotocol/ui`) can render the HTML. Set [`ARCHESTRA_API_BASE_URL`](/docs/reference/configuration#ARCHESTRA_API_BASE_URL) so its asset URLs resolve. The host controls its own iframe. Archestra's network policy holds only on Archestra's own pages, and the [shared-app risks](#shared-apps) apply in full.
