---
title: Confluence
description: Connect Confluence documents to Knowledge and configure source access
order: 2
lastUpdated: 2026-10-05
---

Let agents answer from your Confluence wiki, with a link to each page. Runbooks, design docs, and team pages become searchable, and private spaces can stay private.

**Indexed:** pages from Confluence Cloud or Server.

**Authentication:** Confluence Cloud uses an Atlassian account email and API token. Confluence Server and Data Center with PAT support use a personal access token with the Username field empty. On older releases, enter the account username and password for Basic authentication.

## Connecting Confluence

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Confluence** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| URL            | Your Confluence site root (e.g., `https://your-domain.atlassian.net`)         |
| Cloud Instance | Toggle on for Confluence Cloud, off for Server/Data Center                    |
| Space Keys     | Comma-separated space keys to sync (optional)                                 |
| Page IDs       | Comma-separated specific page IDs to sync (optional)                          |
| CQL Query      | Custom CQL to filter content (optional)                                       |

## Confluence Auto-Sync Permissions

For Confluence Cloud, use a dedicated account with product access:

1. Create an unscoped API token from [Atlassian account security](https://id.atlassian.com/manage-profile/security/api-tokens).
2. Enter the site root, such as `https://example.atlassian.net`, without `/wiki`.
3. Grant **View** on every synced space. Add the account to every page and ancestor restriction it must index.
4. Grant **Confluence Administrator** when audit-based incremental permission reads are required.
5. Create a separate [organization admin API key](/docs/knowledge/connectors#atlassian-organization-admin-api-key) to resolve private managed-account emails.

A Cloud administrator does not automatically bypass page restrictions through the API. Unreadable pages never enter the index.

For Confluence Server or Data Center with PAT support, create a token under **Profile > Personal access tokens** and leave **Username** empty. On older releases, enter the username in **Username** and the password in **API Token / Personal Access Token**. Membership in the `confluence-administrators` group provides the broadest space and restricted-page visibility.
