---
title: Outline
description: Connect Outline documents to Knowledge and configure source access
order: 13
lastUpdated: 2026-10-05
---

Let agents answer from the published documents in your [Outline](https://www.getoutline.com/) wiki.

**Indexed:** published documents. Both Outline cloud (`https://app.getoutline.com`) and self-hosted instances are supported.

**Authentication:** an Outline API key. Create one under **Settings > API & Apps** in your Outline workspace. Only documents the key has access to are synced.

## Connecting Outline

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Outline** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field          | Description                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Instance URL   | The base URL of your Outline workspace (e.g. `https://app.getoutline.com` or your self-hosted URL).    |
| API Key        | Your Outline API key (starts with `ol_api_`).                                                          |
| Collection IDs | Optional comma-separated list of collection IDs to sync. Leave blank to sync all accessible documents. |

## Outline Auto-Sync Permissions

Create an API key under **Settings > API & Apps**. An unscoped key inherits its creator's endpoint and collection access. For a scoped key, grant `auth.info`, `documents.list`, `users.list`, `groups.list`, `groups.memberships`, `collections.list`, `collections.info`, `collections.memberships`, `collections.group_memberships`, and `shares.list`.

Use a dedicated admin that belongs to every private target collection. Admin status does not automatically reveal a private collection. User emails come from `users.list`, so an account that cannot list users leaves all members unresolved.

Each collection is one permission scope. A collection's audience is its individual members, its granted groups, and — when the collection has workspace-wide default access — every active workspace member except guests. Guests only see collections they are explicitly added to, directly or through a group.

Published share links are the only public surface. A published document share maps that document — and its child documents, when the share includes them — to everyone in your Archestra organization. A published collection share does the same for the whole collection.

A collection whose permissions cannot be read hides its documents from everyone until a later sync reads them. Documents an Outline user can only reach through a direct per-document share (not a public link) are not carried over; they stay limited to the collection's audience.
