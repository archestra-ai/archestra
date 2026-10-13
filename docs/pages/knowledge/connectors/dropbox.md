---
title: Dropbox
description: Connect Dropbox documents to Knowledge and configure source access
order: 11
lastUpdated: 2026-10-05
---

Let agents answer from the files in a Dropbox account or team folder. The connector syncs text and source files.

**Indexed:** text, source files, PDFs, and Office documents, including all sheets of an Excel workbook. Images are indexed when the embedding model accepts image input. Unsupported files are reported as skipped in the run.

**Authentication:** a Dropbox access token from the [Dropbox App Console](https://www.dropbox.com/developers/apps). The connector stores this token directly and does not refresh it.

## Connecting Dropbox

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Dropbox** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field      | Description                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Folder Path  | Folder path to scope the sync (e.g., `/team-docs`). Leave blank to sync the entire account.              |
| File Types | Comma-separated file extensions to include (e.g., `.md, .txt`). Leave blank to sync all supported types. |

## Dropbox Auto-Sync Permissions

Create a scoped app with **Full Dropbox** access. Add `account_info.read`, `files.metadata.read`, `files.content.read`, and `sharing.read`. Generate a member token when direct user and shared-folder grants are enough.

Group expansion requires a Dropbox Business team app. Add `team_info.read`, `team_data.member`, and `groups.read`, then have an active team administrator authorize the app. Paste the resulting team-linked token into **Access Token**.

App Console generated access tokens are short-lived testing credentials. The connector stores only the access token and cannot refresh it, so scheduled content and permission sync stop after expiration. Reconnect with a new token; durable background sync requires an offline OAuth flow, which is not yet supported.

Each shared folder is one permission scope — a file belongs to its nearest containing shared folder. Files outside every shared folder are visible only to the token's account. Shared-folder members resolve to their emails directly; pending invitees are excluded until they accept. A file shared with extra people directly carries those people as additional grants. A file shared directly with a group does not carry that group — only shared-folder group grants are mirrored.

A team-linked token expands granted groups, including the automatic team-wide group, to active members. A member token leaves group rosters empty and fail-closed; manual assignment cannot populate them. Direct grantees appear under the synthetic `direct-grants` group.

Shared links are not reflected. A file shared only by link stays visible to the audiences above, nobody more.
