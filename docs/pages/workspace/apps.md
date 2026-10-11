---
title: Interactive Apps
description: Build, run, share, and govern agent-scaffolded interactive apps and dashboards
order: 2
lastUpdated: 2026-10-11
---

An app is an interactive interface you build on demand by prompting an agent — such as a dashboard, intake form, or status tracker. Apps execute inside a secure browser sandbox, maintain persistent state, and invoke MCP tools using the credentials of the person running them.

The **Apps** gallery also includes apps provided by installed MCP servers. For app implementation code, see the [Apps SDK Reference](/docs/reference/apps-sdk).

![Apps available in the gallery](/docs/automated_screenshots/chat-apps_gallery.webp)

## Building an App with an Agent

Prompt an agent in chat to generate interactive UI tools tailored to your workflow.

1. Ask an agent in chat to build an app (for example, "build me a tracker for open vendor reviews").
2. The agent asks up to three clarifying questions, scaffolds the application code, and displays the running app inline.
3. Continue conversing in the same chat to request style tweaks, add input fields, or connect new tools.

Each modification saves a new revision to history. To revert a change, open the app's menu on the **Apps** page, select **Version history**, and restore an earlier version. Restoring writes a new version without erasing intermediate history.

## Running an App

Launch apps from the workspace gallery, embedded inside conversations, or standalone in full screen.

- **From the Apps gallery:** Select an app card from **Apps** (`/apps`). Opening an app creates a new chat session that joins your chat list once you interact ([`app:read`](/docs/reference/permissions#app:read)).
- **Standalone:** Open the app at `/a/<slug>` for a focused view without chat chrome.
- **In chat:** Apps render directly in the message flow when generated or opened by an agent.
- **Fullscreen mode:** Select the fullscreen icon on the app hover bar or side panel header to expand the app. In App settings, set **Opens in** to **Fullscreen** to launch full screen by default.

Each app is backed by its own MCP server. Its permissions, environment, assigned tools, and deletion are managed from its card in the [MCP registry](/docs/mcp/servers).

## Sharing and Access Grants

Grant fine-grained permissions to users, teams, or roles while preserving credential boundaries.

Configure access using [Resource permission grants](/docs/admin/access-control#granular-access-control):

| Access | Allows |
| --- | --- |
| Read | Seeing the app card in the gallery |
| Use | Running the app and invoking its tools |
| Update | Editing the app code, settings, and tools |

Managing permissions requires a separate grant. The creator starts with full access. Sharing a chat does not share the apps inside it — each viewer requires independent access to each app.

Apps execute with the permissions and credentials of the active viewer, not the creator. Share apps only with people you trust with the app's tools and data; see [Shared-App Trust Boundary](/docs/reference/apps-sdk#shared-apps).

### Disabling an App

Turn off an app in **App settings** to retract it without deleting data.

Disabling an app removes it from other members' galleries and from all agent toolboxes. No chat can inspect or execute it, including your own. The app remains in your gallery marked Disabled until you turn it back on.

### Transferring Ownership

Transfer an app you own to another organization member.

Its URL slug, version history, persistent state, sharing grants, and backing MCP server transfer with it. Tool executions continue to use each viewer's credentials.

## Locking an App

Lock completed apps to prevent automated agent edits or unintended modifications.

A locked app is immutable to autonomous agents: agents will refuse edit requests, tool changes, or deletion until unlocked. Viewing and running the app are unaffected.

Agents only unlock an app when explicitly commanded to do so by a user with update permissions. You can also toggle the lock manually in App settings.

## Defaults for New Apps

Configure organization-wide defaults in Settings to enforce review gates before new apps go live.

Go to **Settings → Apps** ([`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update)) to set default behaviors for newly created apps:

- **New apps are disabled by default** — Creates all new apps disabled: author-only, invisible to agents, and unrunnable until explicitly enabled in App settings.
- **New apps are locked by default** — Creates all new apps [locked](#locking-an-app) against automated agent modification.

The creating conversation can finish building the app under either default policy. Policies take effect once the initial creation session concludes or the app is manually edited.

## Icons and Labels

Categorize and brand apps across the gallery and chat interface.

Assign an emoji or upload an image in App settings. The icon appears in the `/apps` gallery, sidebar pinned list, and chat pills. Setting an app icon automatically updates its backing MCP server in the [MCP registry](/docs/mcp/servers).

Add key-value tags (such as `team: finance` or `env: prod`) under **Labels** in App settings. The `/apps` gallery provides multi-tag filtering across both custom apps and installed MCP server apps.
