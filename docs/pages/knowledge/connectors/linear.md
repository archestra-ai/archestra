---
title: Linear
description: Connect Linear documents to Knowledge and configure source access
order: 12
lastUpdated: 2026-10-05
---

Let agents answer from your Linear workspace: issues, projects, and cycles.

**Indexed:** issues by default, with optional projects (and recent updates) and cycles.

**Authentication:** a Linear personal API key. Create one under **Settings > Security & access > Personal API keys** in Linear, then paste it into the connector's **Personal Access Token** field.

## Connecting Linear

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Linear** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field            | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| Linear API URL   | GraphQL API base URL (default: `https://api.linear.app`)                   |
| Team IDs         | Comma-separated team IDs to scope sync (optional)                          |
| Project IDs      | Comma-separated project IDs to scope sync (optional)                       |
| Issue States     | Comma-separated issue state names (e.g. `Todo, In Progress, Done`)         |
| Include Comments | Include issue comments in indexed content (default: on)                    |
| Include Projects | Sync projects and recent project updates as documents (default: off)       |
| Include Cycles   | Sync cycles as documents (default: off)                                    |

## Linear Auto-Sync Permissions

Create a personal API key under **Settings > Account > Security & Access > Personal API keys**. Select **Read** and every team the connector will sync. Use a dedicated workspace owner or administrator that belongs to every private team; the role alone does not grant private-team access.

Linear returns member emails through the same key. No extra scope is required.

Linear's access unit is the team. Issues and cycles get their team's audience: a public team admits every workspace member, a private team only its listed members. Guests get access only through teams they were invited to. A project's audience is the members of its teams plus the users listed on the project. Each sync also snapshots every team's roster, so the connector's **Users** and **Groups** tabs show each member with their assignment status. Suspended accounts belong to no audience.

The API key sees what its owner can see. A private team the owner does not belong to syncs no content and grants no access. Use a key from an owner whose access matches what you want indexed.
