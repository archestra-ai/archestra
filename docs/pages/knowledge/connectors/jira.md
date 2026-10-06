---
title: Jira
description: Connect Jira documents to Knowledge and configure source access
order: 1
lastUpdated: 2026-10-05
---

Let agents answer from your Jira issues: "Has anyone reported this login error before?" finds the old ticket and its fix. The connector syncs issues and their discussions.

**Indexed:** issue descriptions, comments, and metadata from Jira Cloud or Server.

**Authentication:** Jira Cloud uses an Atlassian account email and API token. Jira Server and Data Center use a personal access token with the Username field empty. On releases without personal access tokens, enter the account username and password for Basic authentication.

## Connecting Jira

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Jira** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                   | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| URL                | Your Jira instance URL (e.g., `https://your-domain.atlassian.net`) |
| Cloud Instance          | Toggle on for Jira Cloud, off for Jira Server/Data Center          |
| Project Keys            | Comma-separated project keys to include (optional)                 |
| JQL Query               | Custom JQL to filter issues (optional)                             |

## Jira Auto-Sync Permissions

For Jira Cloud, use a dedicated Jira administrator:

1. Create an API token from [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens). Choose an unscoped token for the connector's site URL.
2. Grant the account **Administer Jira** and **Browse users and groups** global permissions.
3. Grant **Browse Projects** on every synced project. Add the account to every issue-security level whose issues it must index.
4. Create a separate [organization admin API key](/docs/knowledge/connectors#atlassian-organization-admin-api-key) to resolve private managed-account emails.

The product API token reads Jira data. The organization key reads managed-account profiles only. External accounts still need public profile emails or [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).

Jira Server and Data Center content sync remains supported, but auto-sync permissions is not. Its permission APIs differ from Jira Cloud, and Jira exposes no equivalent REST API for issue-security membership. Use a personal access token if your Jira version supports it. On older releases, enter the username in **Username** and the password in **API Token / Personal Access Token** to use Basic authentication.

Do not enable auto-sync permissions for Jira Cloud projects that use issue security. Jira requires both **Browse Projects** and issue-security membership, but the connector cannot currently enforce that intersection. Browse Projects grants through Project Lead or user/group custom fields, and dynamic issue-security holders such as Reporter and Assignee, are also unsupported.
