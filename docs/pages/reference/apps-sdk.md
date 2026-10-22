---
title: Apps SDK Reference
description: The window.archestra SDK, styling, security model, and authoring tools for MCP Apps
order: 5
lastUpdated: 2026-10-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

An [MCP App](/docs/chat/apps) calls MCP tools as the viewer, keeps private and shared state, and runs model completions through `window.archestra`, with no tokens, backend, or login code. This page lists the SDK, the injected styles, and the sandbox limits. Agents write apps with the built-in **Build App** skill, which follows the same rules.

<span id="the-sdk"></span>

## SDK Methods

The platform injects the SDK into every app as `window.archestra` when the app loads. Do not import the SDK, load its script, or wire `postMessage` yourself: a save is rejected when the HTML sets up its own host connection.

`window.archestra` exists as soon as the page loads. Await `archestra.ready` before the first call. Every method is async except `files.onChange`, `ui.updateModelContext`, and `llm.prompt`. If the host connection fails, `archestra.ready` and every method reject with that error.

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
| `list()` | `[{ key, value, revision, owner }]`, sorted by key |
| `delete(key)` | nothing |

Values are plain JSON. Pass objects to `set` directly, without `JSON.stringify`. A top-level `null` cannot be stored; call `delete` to clear a key.

- A key is 1 to 256 characters. A value is up to 256 KB of JSON.
- Each partition holds up to 1,000 keys. Each viewer's private partition counts separately.

After a `get` or `list`, a `set` of the same key succeeds only if nobody else wrote it in between. Otherwise it rejects with `{ code: "conflict" }`; read the key again and retry. A `set` of a key the app has not read has no check, and the last write wins. Two `set` options change this:

- `ifRevision` - Write only if the stored revision matches this number. `0` means "create, and fail if the key exists". `null` turns the check off, and the last write wins.
- `owned: true` - Claim a new shared key for the viewer. Only that viewer, the app's author, and anyone with `update` on every app can then overwrite or delete it. Other writes reject with `{ code: "forbidden" }`.

Do not use `localStorage`, `sessionStorage`, or IndexedDB. Without a sandbox domain they throw. Where they work, the data stays in one browser, and no other viewer sees it.

### Files

`archestra.files` is a file store private to each viewer of the app. It never shows a chat's files, a project's files, or another viewer's files. The store is the same wherever the app runs: inline in chat, on its own page, or in an external MCP client.

| Method | Does |
| --- | --- |
| `list(query?)` | Resolves to up to 200 files, as `[{ id, ref, filename, mimeType, sizeBytes, createdAt }]`. `query` filters by a filename substring. |
| `read(filename \| { id } \| { filename })` | Resolves to a browser `File` with the exact bytes, whatever the type. |
| `save(filename, data, opts?)` | Writes a string, `Blob`, `ArrayBuffer`, or typed array. Replaces a file of the same name unless `opts.overwrite` is `false`. `opts.mimeType` sets the type. Resolves to `{ id, filename, mimeType, sizeBytes, overwritten }`. |
| `delete(filename \| { id })` | Removes the file. |
| `onChange(listener)` | Calls `listener` when the store changes, including when an agent copies a file in from chat. Returns an unsubscribe function. The event has no payload. Call `list()` again. Not every host sends it, so also call `list()` when the viewer opens a file picker. |

Use files for documents the app produces or the viewer keeps, such as a generated report. Use storage for structured state.

- A filename is a plain name of up to 256 characters, with no `/`, `\`, or leading dot.
- A file can be up to [`ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT`](/docs/admin/deployment/configuration#ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT) bytes.

### Tools

- `archestra.tools.list()` - The assigned tools the viewer may call, plus the built-in file tools, each with its input schema.
- `archestra.tools.call(name, args)` - Calls an assigned tool. Pass `name` exactly as `tools.list()` returns it, for example `github__list_issues`.

`tools.call` resolves to the first of these that the result has:

1. `structuredContent`
2. `{ text, resources: [{ uri, mimeType, text }] }` when the result embeds resources. A file-read tool, such as GitHub's `get_file_contents`, returns the file body in `resources[0].text`. A binary file carries `dataUrl` instead of `text`.
3. JSON parsed from the text output
4. The raw text
5. `{ media: [{ type, mimeType, dataUrl }] }` for an image-only or audio-only result. Use `dataUrl` directly as an `img` or `audio` source.
6. `null`

A tool runs as the viewer, with the viewer's own MCP credentials: their personal connection first, then their team's, then the organization's. App code holds no tokens.

When the viewer has not connected the tool's MCP server, or must reconnect it, the call rejects with `{ code: "auth_required", url }`. Show the error message with `url` as a link. Once the viewer connects, the next call succeeds.

An app can call only its assigned tools and its own storage, file, and LLM methods. `tools.call` also runs the built-in file tools that `archestra.files` does not wrap, such as [`read_file`](/docs/reference/archestra-mcp-server#read_file) and [`edit_file`](/docs/reference/archestra-mcp-server#edit_file). Assign tools from the app's **Tools** tab in the MCP Registry, or with the `tools` argument of [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app) and [`set_app_tools`](/docs/reference/archestra-mcp-server#set_app_tools). Assignable tools come from the app's [environment](/docs/admin/environments) and the Default environment.

### LLM

- `archestra.llm.complete(prompt, { system, jsonMode })` - Runs one completion as the viewer and resolves to the model's text. Use it to summarize, classify, or extract from data the app already has; it cannot fetch anything.
- `archestra.llm.prompt` - A tagged-template helper that builds a prompt string.

- The completion uses the model of the [App Runtime LLM Agent](/docs/agents/subagents/built-in#app-runtime-llm-agent), or the organization default when it has none. The app cannot choose one.
- It counts against the viewer's [usage limits](/docs/llm-proxy/costs-and-limits) and appears in the logs. `prompt` takes up to 100,000 characters, and `system` up to 10,000.
- With `jsonMode`, the model returns one JSON value, which the app still parses.

### Host UI

- `archestra.ui.openLink(url)` - Opens an `http` or `https` link in a new tab. This is the only way to open one: the sandbox blocks popups, so `<a target="_blank">` does nothing.
- `archestra.ui.requestDisplayMode(mode)` - Switches the display. Pass `"inline"` or `"fullscreen"`. Other values leave the display unchanged.
- `archestra.ui.updateModelContext(text)` - Tells the chat model what the app is showing, in one short line ("Viewing invoice-2026.pdf, page 3"). The model sees the first 500 characters. The latest call wins. Until an app calls it, `files.read` reports the open file automatically.

### Errors

SDK calls reject with an error that carries a `code`. A call with invalid arguments throws a `TypeError` without one.

| Code | Cause |
| --- | --- |
| `auth_required` | The viewer has not connected the tool's MCP server, or must reconnect it. The error carries `url`. |
| `conflict` | Another write changed the key since the app read it, or the partition is full. |
| `forbidden` | The shared key is owned by another viewer. |
| `llm_quota` | A usage limit was reached, or the model provider rate-limited the call. Back off and retry. |
| `llm_unavailable` | The completion failed for another reason. |
| `tool_error` | Any other failed call, such as a value over 256 KB or a missing file. |

## Styling

The platform injects a baseline stylesheet ahead of the app's own CSS. App rules override it. Do not link it yourself: a save is rejected when the HTML does. The stylesheet provides:

- **Theme variables** that follow light and dark mode: `--color-text-primary`, `--color-text-secondary`, `--color-text-danger`, `--color-text-inverse`, `--color-background-primary`, `--color-background-secondary`, `--color-background-inverse`, `--color-border-primary`, `--color-accent`, `--border-radius-sm`, `--border-radius-md`, `--border-radius-lg`, `--font-sans`, and `--font-mono`.
- **Element defaults** for `body`, headings, `p`, links, lists, `button`, `input`, `textarea`, and `select`.
- **Components**: `.arch-card`, `.arch-btn` (with `--primary` and `--ghost`), `.arch-input`, `.arch-tabs` and `.arch-tab`, `.arch-badge`, and `.arch-spinner`.

The `hidden` attribute always hides an element, even when app CSS sets `display`. Write only the CSS your app needs, not a full theme.

## Security Model

### Network Access

Every app renders under one platform policy; app authors cannot change it. The app has no network access: `fetch`, XHR, and WebSockets to any external address fail. Assigned MCP tools are the only way to get data in or out.

Scripts, styles, fonts, and images can load from these CDNs, so apps can use client-side libraries:

- `cdn.jsdelivr.net`
- `unpkg.com`
- `cdnjs.cloudflare.com`
- `fonts.googleapis.com`
- `fonts.gstatic.com`

- A script loaded from a CDN runs inside the app and can call its tools as the viewer. Pin package versions in CDN URLs, so a new release cannot change the app's code.
- Images, audio, and video from any other host do not load. Use a tool result's `dataUrl` instead.
- An app cannot embed another page in an iframe. Native form submission is blocked, so handle `submit` in script and call `preventDefault()`.

### Device Permissions

Declare `camera`, `microphone`, `geolocation`, or `clipboardWrite` with the `uiPermissions` argument of [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app). The browser still asks the viewer for consent on first use.

These permissions work only when the sandbox has its own origin: with [`ARCHESTRA_MCP_SANDBOX_DOMAIN`](/docs/admin/deployment/configuration#ARCHESTRA_MCP_SANDBOX_DOMAIN) set, or on `localhost` in local development. Without one, the browser blocks them.

### Shared Apps

A team or organization app runs code its author wrote in each viewer's browser. Three layers protect the viewer:

- The HTML runs in an isolated sandbox iframe.
- The network policy blocks every path except assigned MCP tools.
- Every tool, storage, and file call is checked against the viewer's permissions, not the author's.

The app's code can read the viewer's name and email and call tools with the viewer's credentials. It can also copy what it reads into shared storage, where the author can read it. Run a shared app only when you trust its author.

### Permissions

Running an app needs `use` on it, granted per item through [Granular Access Control](/docs/admin/access-control#granular-access-control). That grant covers the app's storage and LLM calls. File calls also need [`agent:read`](/docs/reference/permissions#agent:read).

## Authoring Tools

Agents build apps with these built-in tools. [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app) starts every app from a page with its name and the organization's logo. An app's HTML can be up to 512 KB.

| Tool | Use |
| --- | --- |
| [`scaffold_app`](/docs/reference/archestra-mcp-server#scaffold_app) | Creates an app, optionally with its first tool assignments. |
| [`refine_app`](/docs/reference/archestra-mcp-server#refine_app) | Records what the app should do as a spec, after asking the user up to three clarifying questions. |
| [`edit_app`](/docs/reference/archestra-mcp-server#edit_app) | Changes the HTML with targeted replacements or a full document. Each edit creates a new version. |
| [`read_app`](/docs/reference/archestra-mcp-server#read_app) | Returns the current HTML. |
| [`set_app_tools`](/docs/reference/archestra-mcp-server#set_app_tools) | Replaces the app's tool assignments. |
| [`preview_app_tool`](/docs/reference/archestra-mcp-server#preview_app_tool) | Runs one assigned tool as the viewer and returns its real output, which app code then parses. |
| [`validate_app`](/docs/reference/archestra-mcp-server#validate_app) | Checks the HTML without rendering it. |
| [`get_app_diagnostics`](/docs/reference/archestra-mcp-server#get_app_diagnostics) | Returns the latest render result: `clean`, `errors` with the captured errors, or `no_render_observed`. |
| [`render_app`](/docs/reference/archestra-mcp-server#render_app) | Shows an existing app in chat. |
| [`restore_app_version`](/docs/reference/archestra-mcp-server#restore_app_version) | Restores an earlier version as a new version. |
| [`publish_app`](/docs/reference/archestra-mcp-server#publish_app) | Shares the app with a team or the organization. |
| [`copy_file`](/docs/reference/archestra-mcp-server#copy_file) | Copies files between a chat and the open app. |

For every app tool, see [Apps](/docs/reference/archestra-mcp-server#apps).

### Render Diagnostics

Each render records errors, unhandled rejections, console output, policy violations, and elements whose CSS overrides `hidden`. Errors show on the app card and reach the agent with the viewer's next chat message. [`get_app_diagnostics`](/docs/reference/archestra-mcp-server#get_app_diagnostics) returns the caller's latest render of the current version, with a screenshot when the caller is the app's author. A render happens only when someone opens the app.

## External MCP Clients

Each app is also an MCP server at [`POST /api/mcp/app/<app-id>`](/docs/reference/api#/mcp-proxy/mcpAppProxyPost). A client that supports OAuth connects with the URL alone and signs the person in. Other clients send a personal token. Organization and team tokens are rejected, because an app needs a viewer.

The client sees:

- `tools/list` - An `open` tool that shows the app, the app's assigned tools, and its storage tools. Its LLM and file tools are also listed, marked for the app's own code, so the host's model does not call them.
- `resources/read` - The app's HTML.

Tool calls use the connecting user's credentials, as they do inside Archestra. A host that supports MCP Apps (`io.modelcontextprotocol/ui`) can render the HTML. The HTML carries Archestra's network policy into the host. The host controls the rest of its iframe, and the [shared-app risks](#shared-apps) apply in full.
