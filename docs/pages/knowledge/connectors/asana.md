---
title: Asana
description: Connect Asana documents to Knowledge and configure source access
order: 5
lastUpdated: 2026-10-05
---

Let agents answer from your Asana projects: "What is blocking the Q3 launch?" finds the tasks and their comments. The connector syncs tasks and discussions.

**Indexed:** tasks and their user comments from selected Asana projects.

**Authentication:** a [personal access token](https://developers.asana.com/docs/personal-access-token).

## Connecting Asana

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Asana** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field         | Description                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------- |
| Workspace GID | Your Asana workspace GID (found in the URL when viewing your workspace)                       |
| Project GIDs  | Comma-separated project GIDs to sync (optional -- leave blank to sync all workspace projects) |

## Asana Auto-Sync Permissions

Create a token in the [Asana Developer Console](https://app.asana.com/0/my-apps). Personal access tokens have no selectable scopes and inherit the user's visibility. Add that user to every private project and team the connector syncs.

Asana Enterprise organizations can use a service account instead. A super admin creates it under **Admin console > Apps > Service accounts**. Grant **Full Permissions**, because standard task and membership APIs require that level.

Both credentials expose workspace-member emails. A missing email still needs [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).

Each project is one permission scope. A project shared with the whole workspace grants every workspace member — guests excluded. Any other project grants its explicit members: users directly, teams through their team rosters. A task in several projects is readable through any of them; its scope is the union of those audiences. Task collaborators are granted individually on their tasks.

Permission reads run as the token's user. A project or roster the token cannot read stays fail-closed — use a token from a user who can see every synced project. A task removed from every synced project is hidden until a sync sees it again.
