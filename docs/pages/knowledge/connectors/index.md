---
title: Knowledge Connectors
sidebarTitle: Connectors
description: Supported knowledge connectors, their setup, and how each one syncs source permissions
order: 1
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A knowledge connector copies one source, such as Confluence or Google Drive, and keeps the copy current. Agents and MCP clients then search it, and cite the document each answer came from.

![Connectors page with seven connectors, their sync schedules, and the status of each last sync](/docs/automated_screenshots/knowledge_connectors.webp)

- Pick from 17 sources. Each has its own setup page.
- Set how often it syncs. Answers are only as current as the last sync.
- Search keeps access rules. With permission sync on, a private Confluence space stays private.

## Sources

Each source page lists its credential, its fields, and its permission setup. The second column says how much of the source's access rules the connector copies:

- Supported: every document keeps its access rules from the source.
- Limited: the rules are copied with a gap. The row names the gap.
- Not supported: the connector's own grants decide who finds each document.

| Source | Auto-sync permissions |
| --- | --- |
| <span id="asana"></span><span id="asana-auto-sync-permissions"></span>[Asana](/docs/knowledge/connectors/asana) | Supported |
| <span id="confluence"></span><span id="confluence-auto-sync-permissions"></span>[Confluence](/docs/knowledge/connectors/confluence) | Supported |
| <span id="dropbox"></span><span id="dropbox-auto-sync-permissions"></span>[Dropbox](/docs/knowledge/connectors/dropbox) | Limited: stored access tokens cannot refresh |
| <span id="github"></span><span id="github-auto-sync-permissions"></span>[GitHub](/docs/knowledge/connectors/github) | Supported |
| <span id="gitlab"></span><span id="gitlab-auto-sync-permissions"></span>[GitLab](/docs/knowledge/connectors/gitlab) | Supported |
| <span id="google-drive"></span><span id="google-drive-auto-sync-permissions"></span>[Google Drive](/docs/knowledge/connectors/google-drive) | Limited: depends on the authentication mode |
| <span id="jira"></span><span id="jira-auto-sync-permissions"></span>[Jira](/docs/knowledge/connectors/jira) | Limited: Jira Cloud only, and issue security is not supported |
| <span id="linear"></span><span id="linear-auto-sync-permissions"></span>[Linear](/docs/knowledge/connectors/linear) | Supported |
| <span id="m-files"></span><span id="m-files-auto-sync-permissions"></span><span id="m-files-vaf-add-on"></span>[M-Files](/docs/knowledge/connectors/m-files) | Supported with the VAF Add On |
| <span id="notion"></span><span id="notion-auto-sync-permissions"></span>[Notion](/docs/knowledge/connectors/notion) | Limited: every synced page is visible to all workspace members |
| <span id="onedrive"></span><span id="onedrive-auto-sync-permissions"></span>[OneDrive](/docs/knowledge/connectors/onedrive) | Supported |
| <span id="outline"></span><span id="outline-auto-sync-permissions"></span>[Outline](/docs/knowledge/connectors/outline) | Supported |
| <span id="perforce-helix-core"></span><span id="perforce-auto-sync-permissions"></span>[Perforce](/docs/knowledge/connectors/perforce) | Supported with the Kubernetes orchestrator |
| <span id="salesforce"></span><span id="salesforce-auto-sync-permissions"></span>[Salesforce](/docs/knowledge/connectors/salesforce) | Limited: restriction rules and field-level access are not copied |
| <span id="servicenow"></span><span id="servicenow-auto-sync-permissions"></span>[ServiceNow](/docs/knowledge/connectors/servicenow) | Limited: ITSM participant audiences only, and advanced criteria are not supported |
| <span id="sharepoint"></span><span id="sharepoint-auto-sync-permissions"></span>[SharePoint](/docs/knowledge/connectors/sharepoint) | Limited: site pages use library audiences, and site groups are not resolved |
| <span id="web-crawler"></span>[Web Crawler](/docs/knowledge/connectors/web-crawler) | Not supported |

## Create a Connector

First, an admin must set an [embedding model](/docs/knowledge/settings#embedding-model).

1. Go to **Knowledge → Connectors**, click **Create Connector**, and pick a source.
2. Enter the credential and what to index. The source's page says what each one needs.
3. Set who can use it under **Permissions**, and how often it syncs under **Advanced**.
4. Save, open the connector, and click **Test Connection**.
5. Check the first sync run for indexed documents or errors.
6. Add the connector to a [Knowledge Base](/docs/knowledge#connectors-bases-and-files), or pick it in an agent's **Tools & Knowledge**.

## Auto-Sync Permissions

Permission sync copies each source's own access rules. A person then finds only the documents they can open in that source. Each search uses the latest copy of the rules.

Turn on **Sync permissions from the source** on the connector's **General** tab. You need:

- The Knowledge Enterprise feature. See [Pricing Model](/docs/get-started/pricing-model).
- A source that supports it. See the [Sources](#sources) table.
- [`knowledgeSource:create`](/docs/reference/permissions#knowledgeSource:create) to create the connector, or [`knowledgeSource:update`](/docs/reference/permissions#knowledgeSource:update) to change it.
- The source's own setup. Each source page has an **Auto-Sync Permissions** section.

<span id="credentials-and-email-resolution"></span>

### Connector Identity

Give the connector one dedicated identity that can read every document you sync and its permissions.

- A document whose permissions the identity cannot read is hidden from everyone.
- **Test Connection** checks only the sign-in. It does not check access to each project or permission table.

### Match Source Accounts to People

Archestra matches each source account to a person by email. An account with no match gets no documents.

| Problem | Fix |
| --- | --- |
| The account has a hidden or empty email | Assign it to a person by hand under **Users**. On Jira or Confluence Cloud, add an organization admin API key instead. See [Jira](/docs/knowledge/connectors/jira#organization-admin-api-key) or [Confluence](/docs/knowledge/connectors/confluence#organization-admin-api-key). |
| A group has no members | Fix the group in the source. Assigning by hand cannot add members to a group. |

## Troubleshoot Sync

Open the connector to see each sync run, with its progress, warnings, and errors.

| You see | Do this |
| --- | --- |
| No documents on the first run | Check that the source has documents, the credential can read them, and no filter excludes them all. A later run with no documents is normal when nothing changed. |
| A sync runs too long | Click **Cancel sync** in its **Actions** column. Documents already indexed stay. The next sync starts from the saved checkpoint. |
| Unchanged documents miss a new setting | Click **Force Re-sync** to index them again. |
| A permission sync ended as **Superseded** | Nothing. You changed the settings or credentials, and a new run started at once. |
