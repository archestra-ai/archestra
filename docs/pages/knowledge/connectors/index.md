---
title: Knowledge Connectors
description: Supported knowledge connectors, their setup, and how each one syncs source permissions
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect Confluence, Google Drive, SharePoint, or 14 other sources once. Archestra keeps their documents searchable and follows who may read each one. A connector syncs on a schedule, so agents answer from this week's runbook, not last quarter's.

<span id="supported-connectors"></span><span id="creating-a-connector"></span>

## Create a Connector

First, an admin must set an [embedding model](/docs/knowledge#embedding-model).

1. Go to **Knowledge → Connectors**, click **Create Connector**, and pick a source.
2. Follow that source's page below for the credential and what to index.
3. Set who can use it under **Permissions**, and how often it syncs under **Advanced**.
4. Save, open the connector, and click **Test Connection**.
5. Check the first sync run for indexed documents or errors.
6. Add the connector to a [Knowledge Base](/docs/knowledge#create-a-knowledge-base), or pick it in an agent's **Tools & Knowledge**.

## Auto-Sync Permissions

Copy each source's own access rules, so a person finds only the documents they can open in that source. A private Confluence space stays private in search. Each search uses the latest copy of the rules.

To turn it on, you need the Knowledge Enterprise feature, a supported connector, and permission to create or update knowledge connectors.

Auto-sync permissions works with the connectors marked *Supported* below. *Limited* means the source's access control is mirrored with a coarser audience model — the row says which. The others do not support it yet.

| Connector    | Auto-sync permissions                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| <span id="asana"></span><span id="asana-auto-sync-permissions"></span>[Asana](/docs/knowledge/connectors/asana) | Supported ([setup](/docs/knowledge/connectors/asana#asana-auto-sync-permissions))                                                         |
| <span id="confluence"></span><span id="confluence-auto-sync-permissions"></span>[Confluence](/docs/knowledge/connectors/confluence) | Supported ([setup](/docs/knowledge/connectors/confluence#confluence-auto-sync-permissions))                                                    |
| <span id="dropbox"></span><span id="dropbox-auto-sync-permissions"></span>[Dropbox](/docs/knowledge/connectors/dropbox) | Limited: stored access tokens cannot refresh ([details](/docs/knowledge/connectors/dropbox#dropbox-auto-sync-permissions))                  |
| <span id="github"></span><span id="github-auto-sync-permissions"></span>[GitHub](/docs/knowledge/connectors/github) | Supported ([setup](/docs/knowledge/connectors/github#github-auto-sync-permissions))                                                        |
| <span id="gitlab"></span><span id="gitlab-auto-sync-permissions"></span>[GitLab](/docs/knowledge/connectors/gitlab) | Supported ([setup](/docs/knowledge/connectors/gitlab#gitlab-auto-sync-permissions))                                                        |
| <span id="google-drive"></span><span id="google-drive-auto-sync-permissions"></span><span id="google-workspace-domain"></span><span id="one-google-account"></span><span id="service-account-only"></span>[Google Drive](/docs/knowledge/connectors/google-drive) | Limited by authentication mode ([details](/docs/knowledge/connectors/google-drive#google-drive-auto-sync-permissions))                            |
| <span id="jira"></span><span id="jira-auto-sync-permissions"></span>[Jira](/docs/knowledge/connectors/jira) | Jira Cloud only; issue security unsupported ([details](/docs/knowledge/connectors/jira#jira-auto-sync-permissions))                      |
| <span id="linear"></span><span id="linear-auto-sync-permissions"></span>[Linear](/docs/knowledge/connectors/linear) | Supported ([setup](/docs/knowledge/connectors/linear#linear-auto-sync-permissions))                                                        |
| <span id="m-files"></span><span id="m-files-auto-sync-permissions"></span><span id="m-files-vaf-add-on"></span>[M-Files](/docs/knowledge/connectors/m-files) | Supported with the VAF Add On ([setup](/docs/knowledge/connectors/m-files#m-files-auto-sync-permissions))                                   |
| <span id="notion"></span><span id="notion-auto-sync-permissions"></span>[Notion](/docs/knowledge/connectors/notion) | Limited: every synced page is visible to all workspace members ([details](/docs/knowledge/connectors/notion#notion-auto-sync-permissions)) |
| <span id="onedrive"></span><span id="onedrive-auto-sync-permissions"></span><span id="known-limitations"></span>[OneDrive](/docs/knowledge/connectors/onedrive) | Supported ([setup](/docs/knowledge/connectors/onedrive#onedrive-auto-sync-permissions))                                                      |
| <span id="outline"></span><span id="outline-auto-sync-permissions"></span>[Outline](/docs/knowledge/connectors/outline) | Supported ([setup](/docs/knowledge/connectors/outline#outline-auto-sync-permissions))                                                       |
| <span id="perforce-helix-core"></span><span id="perforce-auto-sync-permissions"></span>[Perforce](/docs/knowledge/connectors/perforce) | Supported with the Kubernetes orchestrator ([setup](/docs/knowledge/connectors/perforce#perforce-auto-sync-permissions))                     |
| <span id="salesforce"></span><span id="salesforce-auto-sync-permissions"></span>[Salesforce](/docs/knowledge/connectors/salesforce) | Limited: restriction rules and field-level access are not mirrored ([setup](/docs/knowledge/connectors/salesforce#salesforce-auto-sync-permissions))                                                    |
| <span id="servicenow"></span><span id="servicenow-auto-sync-permissions"></span>[ServiceNow](/docs/knowledge/connectors/servicenow) | Limited: ITSM participant audiences; advanced criteria unsupported ([setup](/docs/knowledge/connectors/servicenow#servicenow-auto-sync-permissions))                                                    |
| <span id="sharepoint"></span><span id="sharepoint-auto-sync-permissions"></span>[SharePoint](/docs/knowledge/connectors/sharepoint) | Limited: site pages use library audiences; site groups unresolved ([setup](/docs/knowledge/connectors/sharepoint#sharepoint-auto-sync-permissions))                                                    |
| <span id="web-crawler"></span>[Web Crawler](/docs/knowledge/connectors/web-crawler) | Not supported                                                                                             |

### Credentials and Email Resolution

Permission sync uses the connector's upstream identity. That identity must read both content and its permission settings. Unreadable permission data fails closed, so the affected documents grant no access.

External accounts match Archestra users by email. A hidden or empty email leaves that account unassigned and removes it from resolved audiences. Accounts listed under **Users** can be assigned manually. An empty group roster must be fixed upstream because manual assignment cannot add members to it.

Each connector section lists its credential type, required scopes, and upstream setup. Use a dedicated identity whose visibility covers every configured source. **Test connection** validates authentication, but a successful test cannot prove access to every project or permission table.

Editing a connector. Saving new settings or credentials stops the permission sync running against the old ones — that run ends as **Superseded**. A replacement run starts straight away, so you don't wait for the next scheduled one.

### Atlassian Organization Admin API Key

An organization admin API key reads managed accounts' emails through the Atlassian admin APIs. Add it to a Jira or Confluence Cloud connector. Permission sync can then resolve managed users whose profile email is private.

Create the key in [Atlassian administration](https://admin.atlassian.com) under **Settings → API keys**:

1. Select **Create API key** and name it.
2. Leave the key **without scopes**. Permission sync calls the classic admin APIs, which scopes do not cover.
3. Copy the key into the connector's **Organization admin API key** field.

The API token stays required. Atlassian does not accept admin API keys on the Jira and Confluence APIs.

Changing **Cloud Instance** on an existing Jira or Confluence connector changes its authentication method, so re-enter the token or password. Switching to Cloud also requires the Atlassian account email. Switching away from Cloud removes the stored organization admin key. For Server or Data Center, leave **Username** empty while entering a new personal access token to select PAT authentication; re-enter the username when changing a Basic-auth password.


<span id="sync-runs"></span>

## Turn Connector Types Off

Hide the sources your company does not use. Go to **Settings → Knowledge → Available connectors**. Existing connectors of a hidden type keep syncing.

For sync errors, see [When Sync Goes Wrong](/docs/knowledge#sync-runs).
