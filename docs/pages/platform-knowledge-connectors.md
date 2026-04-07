---
title: Knowledge Connectors
category: Knowledge
order: 2
description: Supported connector types, configuration, and management
lastUpdated: 2026-04-05
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Connectors pull data from external tools into knowledge bases on a schedule. Sync is incremental by default, so only new or changed content is processed after the first run. A connector can also be assigned to multiple knowledge bases.

This page focuses on connector-specific setup. Every connector also shares a few common fields in the UI:

- **Name** -- a label for your team
- **Description** -- optional context for other admins
- **Visibility** -- whether the connector is org-wide or team-scoped
- **Schedule** -- when sync runs automatically

Most connector-specific filters live under **Advanced** in the create/edit dialogs.

Connector visibility is part of the broader knowledge source access model. See [Overview - Visibility Modes](/docs/platform-knowledge-bases#visibility-modes) for how connector visibility determines which connector data each user can query.

## Jira

Ingests issue descriptions, comments, and metadata from Jira Cloud or Server.

| Field                   | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| Base URL                | Your Jira instance URL (e.g., `https://your-domain.atlassian.net`) |
| Cloud Instance          | Toggle on for Jira Cloud, off for Jira Server/Data Center          |
| Project Key             | Filter issues to a single project (optional)                       |
| JQL Query               | Custom JQL to filter issues (optional)                             |
| Comment Email Blacklist | Comma-separated emails whose comments are excluded (optional)      |
| Labels to Skip          | Comma-separated issue labels to exclude (optional)                 |

Authentication uses an Atlassian account email and [API token](https://id.atlassian.com/manage-profile/security/api-tokens). Incremental sync uses JQL time-range queries on the `updated` field.

## Confluence

Ingests page content (HTML converted to plain text) from Confluence Cloud or Server.

| Field          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| URL            | Your Confluence instance URL (e.g., `https://your-domain.atlassian.net/wiki`) |
| Cloud Instance | Toggle on for Confluence Cloud, off for Server/Data Center                    |
| Space Keys     | Comma-separated space keys to sync (optional)                                 |
| Page IDs       | Comma-separated specific page IDs to sync (optional)                          |
| CQL Query      | Custom CQL to filter content (optional)                                       |
| Labels to Skip | Comma-separated labels to exclude (optional)                                  |
| Batch Size     | Pages per batch (default: 50)                                                 |

Authentication uses the same Atlassian email + API token as Jira. Incremental sync uses CQL `lastModified` queries.

## GitHub

Ingests issues, pull requests, and their comments from GitHub.com or GitHub Enterprise Server.

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub API URL        | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)               |
| Owner                 | GitHub organization or username that owns the repositories                                      |
| Repositories          | Comma-separated repository names to sync (optional -- leave blank to sync all org repositories) |
| Include Issues        | Toggle to sync issues and their comments (default: on)                                          |
| Include Pull Requests | Toggle to sync pull requests and their comments (default: on)                                   |
| Labels to Skip        | Comma-separated labels to exclude (optional)                                                    |

Authentication uses a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) (PAT). Incremental sync uses the `since` parameter on the issues API to fetch only items updated after the last sync.

## GitLab

Ingests issues, merge requests, and their comments from GitLab.com or self-hosted GitLab instances.

| Field                  | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| GitLab URL             | Instance URL (e.g., `https://gitlab.com` or your self-hosted URL)                  |
| Group                  | GitLab group ID or path to scope project discovery (optional)                      |
| Project IDs            | Comma-separated specific project IDs to sync (optional -- leave blank to sync all) |
| Include Issues         | Toggle to sync issues and their comments (default: on)                             |
| Include Merge Requests | Toggle to sync merge requests and their comments (default: on)                     |
| Labels to Skip         | Comma-separated labels to exclude (optional)                                       |

Authentication uses a [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/) (PAT). System-generated notes (assignment changes, label updates, etc.) are automatically filtered out. Incremental sync uses the `updated_after` parameter.

## ServiceNow

Ingests records from ServiceNow instances via the Table API. HTML descriptions are converted to plain text. Multiple entity types can be enabled via toggles.

| Field                         | Description                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Instance URL                  | Your ServiceNow instance URL (e.g., `https://your-instance.service-now.com`)                                                  |
| Include Incidents             | Sync incidents from the `incident` table (default: on)                                                                        |
| Include Changes               | Sync change requests from the `change_request` table (default: off)                                                           |
| Include Change Tasks          | Sync change tasks from the `change_task` table (default: off)                                                                 |
| Include Problems              | Sync problems from the `problem` table (default: off)                                                                         |
| Include Business Applications | Sync business applications from the `cmdb_ci_business_app` CMDB table (default: off)                                          |
| States                        | Comma-separated state values to filter by (e.g. `1, 2`). Applies to incidents, changes, change tasks, and problems (optional) |
| Assignment Groups             | Comma-separated assignment group sys_ids to filter by. Does not apply to business applications (optional)                     |
| Batch Size                    | Records per batch (default: 50)                                                                                               |

Authentication supports both basic auth (username + password) and OAuth bearer tokens. When using basic auth, provide the username in the Email field and the password in the API Token field. For OAuth, leave the Email field empty and provide the bearer token. Incidents are synced by default; enable additional entity types in the advanced configuration. States and assignment group filters apply to all entity types except business applications. Incremental sync uses the `sys_created_on` field to fetch only records created since the last run.

## Notion

Ingests pages from Notion workspaces using the Notion API. Page content is fetched from Notion blocks and converted to plain text.

| Field        | Description                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Database IDs | Comma-separated Notion database IDs to sync (optional -- leave blank to sync all accessible pages)      |
| Page IDs     | Comma-separated specific Notion page IDs to sync (optional -- takes precedence over Database IDs)       |

Authentication uses a [Notion integration token](https://www.notion.so/my-integrations) (starts with `secret_`). Create an internal integration in your Notion workspace and share the relevant pages or databases with it. Incremental sync uses the `last_edited_time` field to fetch only pages modified since the last run.

## SharePoint

Ingests documents and site pages from SharePoint Online via the Microsoft Graph API. Text is extracted from `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log` files, as well as `.docx`, `.pdf`, and `.pptx` documents. Site pages are synced with content extracted from web parts. When a multimodal embedding model is configured (e.g., `gemini-embedding-2-preview`), image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) up to 4 MB are also ingested and embedded directly.

| Field         | Description                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Tenant ID     | Your Azure AD (Entra ID) tenant ID or domain (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)       |
| Site URL      | Your SharePoint site URL (e.g., `https://your-tenant.sharepoint.com/sites/your-site`)             |
| Client ID     | Azure AD app registration Application (client) ID                                                  |
| Client Secret | Azure AD app registration client secret value                                                      |
| Drive IDs     | Comma-separated document library IDs to sync (optional -- leave blank to sync all site libraries)   |
| Folder Path   | Restrict sync to a specific folder path within each drive (optional)                                |
| Include Pages | Toggle to sync site pages and their web part content (default: on)                                  |

Authentication uses an Azure AD app registration with client credentials (OAuth2). The app registration requires the `Sites.Read.All` application permission on Microsoft Graph, and admin consent must be granted.

To configure the connector:

- `Tenant ID` comes from **Microsoft Entra ID > App registrations > <your app> > Overview > Directory (tenant) ID**
- `Client ID` comes from **Application (client) ID** on the same page
- `Client Secret` is the secret **Value** from **Certificates & secrets**, not the secret ID
- `Site URL` should be the exact SharePoint site web URL, not just the display name

Known limitation:

- SharePoint file sync currently lists only the direct children of the selected drive root or `Folder Path`. Nested subfolders are not traversed recursively. If you need multiple nested folders today, point `Folder Path` at the specific folder you want to sync or create separate connectors. Recursive traversal is tracked in [issue #3665](https://github.com/archestra-ai/archestra/issues/3665).

Incremental sync uses the `lastModifiedDateTime` field to fetch only items modified since the last run.

## Managing Connectors

Connectors can be managed from either the **Connectors** page or a knowledge base's detail page. After creation you can:

- **Toggle enabled/disabled** -- suspends or resumes the cron schedule
- **Trigger sync** -- runs an immediate sync outside the schedule
- **View runs** -- see sync history with status, document counts, and errors

## Adding New Connector Types

See [Adding Knowledge Connectors](/docs/platform-adding-knowledge-connectors) for a developer guide on implementing new connector types.
