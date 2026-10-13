---
title: Notion
description: Connect Notion documents to Knowledge and configure source access
order: 7
lastUpdated: 2026-10-05
---

Let agents answer from your Notion pages and databases.

**Indexed:** pages from a Notion workspace.

**Authentication:** an internal connection's installation access token. A Workspace Owner creates the connection in the [Notion Developer portal](https://app.notion.com/developers/connections) and copies the token from its **Configuration** tab.

## Connecting Notion

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Notion** and name the connector.
2. Enter the integration token. In Notion, give the connection **Read content** and connect every page or database root to index under **Content access**. Open **Advanced** to select specific page or database IDs.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field        | Description                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Database IDs | Comma-separated Notion database IDs to sync (optional -- leave blank to sync all accessible pages) |
| Page IDs     | Comma-separated specific Notion page IDs to sync (optional -- takes precedence over Database IDs)  |

## Notion Auto-Sync Permissions

Create the credential in the [Notion Developer portal](https://app.notion.com/developers/connections):

1. As a Workspace Owner, create an internal connection in the target workspace.
2. Enable **Read content** and **User information with email addresses** capabilities.
3. Copy the installation access token into **Integration Token**.
4. Under **Content access**, connect every page or database root to sync. Access flows to child pages.

Support is *Limited*. Notion's API does not say who can see a page — there is no sharing endpoint, and teamspaces are not exposed. Archestra cannot mirror per-page access, so every synced page shares one workspace-wide audience:

- A synced page is visible to every workspace member whose Notion email matches an Archestra user's email.
- Each permission sync refreshes the member roster from Notion's users API. The connector page shows a **Workspaces** tab in place of Groups, with one row per connector: the workspace, named as it is in Notion.
- Guests are never in Notion's member listing, so a guest never gains access through Archestra.
- Member emails need the integration capability **"read user information including email addresses"** (integration settings, **Capabilities** tab). A member without a readable email stays unresolvable (fail-closed) until you assign them from the Users tab.

A page that is private or teamspace-restricted in Notion, but shared with the integration, becomes readable by every workspace member through Archestra. Set up the integration's access with that in mind:

- Share only workspace-appropriate content with the integration — a company wiki teamspace, for example.
- Do not share private pages or restricted teamspaces with the integration.
- For content that must reach a narrower audience, use a separate connector with **Team-scoped** visibility.
