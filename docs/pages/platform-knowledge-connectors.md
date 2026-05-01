---
title: Connectors
category: Knowledge
order: 2
description: Supported connector types, configuration, and management
lastUpdated: 2026-04-30
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Connectors pull data from external tools into Knowledge Bases. A connector can be assigned to multiple Knowledge Bases.

## Visibility

Each connector has a visibility setting that determines which users can retrieve its data when an agent calls `query_knowledge_sources`. Connectors and Knowledge Bases are filtered by visibility throughout the UI: users only see sources they have access to, and only those can be assigned to agents and MCP Gateways.

| Mode                      | Behavior                                                                          |
| ------------------------- | --------------------------------------------------------------------------------- |
| **Org-wide**              | All documents accessible to every user in the organization.                       |
| **Team-scoped**           | Documents accessible only to members of the assigned teams.                       |
| **Auto-sync permissions** | ACL entries synced from the source system (user emails, groups). Coming soon — see [#3218](https://github.com/archestra-ai/archestra/issues/3218). |

Users with the `knowledgeSource:admin` role can view and query every connector regardless of visibility.

> **Enterprise only.** Team-scoped visibility and auto-synced ACLs require an enterprise license. Contact [sales@archestra.ai](mailto:sales@archestra.ai) for licensing information.

## Jira

Sync issues and discussions from Atlassian Jira.

**Indexed:** issue descriptions, comments, and metadata from Jira Cloud or Server.

**Authentication:** an Atlassian account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).

| Field                   | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| Base URL                | Your Jira instance URL (e.g., `https://your-domain.atlassian.net`) |
| Cloud Instance          | Toggle on for Jira Cloud, off for Jira Server/Data Center          |
| Project Key             | Filter issues to a single project (optional)                       |
| JQL Query               | Custom JQL to filter issues (optional)                             |
| Comment Email Blacklist | Comma-separated emails whose comments are excluded (optional)      |
| Labels to Skip          | Comma-separated issue labels to exclude (optional)                 |

## Confluence

Sync wiki pages from Atlassian Confluence.

**Indexed:** pages from Confluence Cloud or Server.

**Authentication:** the same Atlassian email and API token used for Jira.

| Field          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| URL            | Your Confluence instance URL (e.g., `https://your-domain.atlassian.net/wiki`) |
| Cloud Instance | Toggle on for Confluence Cloud, off for Server/Data Center                    |
| Space Keys     | Comma-separated space keys to sync (optional)                                 |
| Page IDs       | Comma-separated specific page IDs to sync (optional)                          |
| CQL Query      | Custom CQL to filter content (optional)                                       |
| Labels to Skip | Comma-separated labels to exclude (optional)                                  |
| Batch Size     | Pages per batch (default: 50)                                                 |

## GitHub

Sync issues and pull request discussions from GitHub.

**Indexed:** issues, pull requests, and their comments from GitHub.com or GitHub Enterprise Server.

**Authentication:** a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub API URL        | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)               |
| Owner                 | GitHub organization or username that owns the repositories                                      |
| Repositories          | Comma-separated repository names to sync (optional -- leave blank to sync all org repositories) |
| Include Issues        | Toggle to sync issues and their comments (default: on)                                          |
| Include Pull Requests | Toggle to sync pull requests and their comments (default: on)                                   |
| Labels to Skip        | Comma-separated labels to exclude (optional)                                                    |

## GitLab

Sync issues and merge request discussions from GitLab.

**Indexed:** issues, merge requests, and their comments from GitLab.com or self-hosted GitLab instances. System-generated notes (assignment changes, label updates, etc.) are filtered out.

**Authentication:** a [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/).

| Field                  | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| GitLab URL             | Instance URL (e.g., `https://gitlab.com` or your self-hosted URL)                  |
| Group                  | GitLab group ID or path to scope project discovery (optional)                      |
| Project IDs            | Comma-separated specific project IDs to sync (optional -- leave blank to sync all) |
| Include Issues         | Toggle to sync issues and their comments (default: on)                             |
| Include Merge Requests | Toggle to sync merge requests and their comments (default: on)                     |
| Labels to Skip         | Comma-separated labels to exclude (optional)                                       |

## Asana

Sync tasks and discussions from Asana projects.

**Indexed:** tasks and their user comments from selected Asana projects.

**Authentication:** a [personal access token](https://developers.asana.com/docs/personal-access-token).

| Field         | Description                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------- |
| Workspace GID | Your Asana workspace GID (found in the URL when viewing your workspace)                       |
| Project GIDs  | Comma-separated project GIDs to sync (optional -- leave blank to sync all workspace projects) |
| Tags to Skip  | Comma-separated tag names to exclude (optional)                                               |

## ServiceNow

Sync ITSM records from a ServiceNow instance.

**Indexed:** incidents, change requests, change tasks, problems, and business applications. Incidents are enabled by default; the rest are opt-in.

**Authentication:** basic auth (username + password) or an OAuth bearer token. For basic auth, put the username in the Email field and the password in the API Token field. For OAuth, leave Email empty and put the bearer token in the API Token field.

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

## Notion

Sync pages and databases from a Notion workspace.

**Indexed:** pages from a Notion workspace.

**Authentication:** a [Notion integration token](https://www.notion.so/my-integrations) (starts with `secret_`). Create an internal integration in your workspace and share the relevant pages or databases with it.

| Field        | Description                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Database IDs | Comma-separated Notion database IDs to sync (optional -- leave blank to sync all accessible pages) |
| Page IDs     | Comma-separated specific Notion page IDs to sync (optional -- takes precedence over Database IDs)  |

## SharePoint

Sync documents and site pages from SharePoint Online.

**Indexed:** documents and site pages from SharePoint Online. Supported document types include `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log`, `.docx`, `.pdf`, and `.pptx`. When a multimodal embedding model is configured, image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) up to 4 MB are also indexed.

**Authentication:** an Azure AD app registration with client credentials (OAuth2). The app needs the `Sites.Read.All` application permission on Microsoft Graph, with admin consent granted.

| Field         | Description                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------- |
| Tenant ID     | Your Azure AD (Entra ID) tenant ID or domain                                                      |
| Site URL      | Your SharePoint site URL (e.g., `https://your-tenant.sharepoint.com/sites/your-site`)             |
| Client ID     | Azure AD app registration Application (client) ID                                                 |
| Client Secret | Azure AD app registration client secret value                                                     |
| Drive IDs     | Comma-separated document library IDs to sync (optional -- leave blank to sync all site libraries) |
| Folder Path   | Restrict sync to a specific folder path within each drive (optional)                              |
| Recursive     | Traverse subfolders within each drive or Folder Path (default: on)                                |
| Include Pages | Toggle to sync site pages and their web part content (default: on)                                |

Where to find each value:

- **Tenant ID** — **Microsoft Entra ID > App registrations > <your app> > Overview > Directory (tenant) ID**.
- **Client ID** — Application (client) ID on the same page.
- **Client Secret** — the secret **Value** from **Certificates & secrets** (not the secret ID).
- **Site URL** — the exact SharePoint site web URL, not the display name.

## OneDrive

Ingests files from OneDrive for Business (personal drives of specified users) via the Microsoft Graph API. Text is extracted from `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log` files, as well as `.docx`, `.pdf`, and `.pptx` documents. When a multimodal embedding model is configured (e.g., `gemini-embedding-2-preview`), image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) up to 4 MB are also ingested and embedded directly.

| Field         | Description                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tenant ID     | Your Azure AD (Entra ID) tenant ID or domain (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)                        |
| Client ID     | Azure AD app registration Application (client) ID                                                                    |
| Client Secret | Azure AD app registration client secret value                                                                        |
| User IDs      | Comma-separated list of user principal names or object IDs whose OneDrive to sync (e.g., `user@company.com`)       |
| Folder ID     | Restrict sync to a specific OneDrive folder (optional -- find the ID from the Graph API or a drive item URL)         |
| File Types    | Comma-separated file extensions to include, e.g. `.pdf, .docx` (optional -- leave blank for all supported types)  |
| Recursive     | Traverse subfolders within each user's drive (default: on)                                                          |

Authentication uses an Azure AD app registration with client credentials (OAuth2). The app registration requires the `Files.Read.All` application permission on Microsoft Graph, and admin consent must be granted.

To configure the connector:

- `Tenant ID` comes from **Microsoft Entra ID > App registrations > <your app> > Overview > Directory (tenant) ID**
- `Client ID` comes from **Application (client) ID** on the same page
- `Client Secret` is the secret **Value** from **Certificates & secrets**, not the secret ID
- `User IDs` should be user principal names (UPNs, e.g. `user@company.com`) or Azure AD object IDs for the users whose drives you want to sync

Incremental sync uses the `lastModifiedDateTime` field to fetch only items modified since the last run.

### Known Limitations

- Only OneDrive for Business (work/school accounts) is supported. Consumer OneDrive is not supported.
- Syncs the personal drive (`/drive`) of each specified user; shared libraries are not traversed.

## Google Drive

Sync files from Google Drive (My Drive and Shared Drives).

**Indexed:** files from My Drive and Shared Drives. Supported document types include `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log`, `.docx`, `.pdf`, and `.pptx`. Google Workspace files (Docs, Sheets, Slides) are also indexed. When a multimodal embedding model is configured, image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) are indexed too. Files larger than 10 MB are skipped.

**Authentication:** either a service account JSON key (recommended) or a short-lived OAuth2 access token with the `drive.readonly` scope. For a service account: create one in the [Google Cloud Console](https://console.cloud.google.com/), enable the Google Drive API, download the JSON key, and share the target folders or drives with the service account email. Paste the full JSON contents (or the bearer token) into the **Service Account Key / OAuth Token** field.

| Field               | Description                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drive IDs           | Comma-separated shared drive IDs to sync (optional -- providing Drive IDs automatically enables shared-drive API access; leave blank to sync from My Drive) |
| Folder ID           | Restrict sync to a specific folder (optional -- find the ID in the folder's Google Drive URL)                                                               |
| File Types          | Comma-separated file extensions to include, e.g. `.pdf, .docx` (optional -- leave blank for all)                                                            |
| Recursive Traversal | Sync files from all nested subfolders when a Folder ID is set (default: on)                                                                                 |

## Dropbox

Sync text and source files from a Dropbox account or team folder.

**Indexed:** text-based files from a Dropbox account or team folder. Supported extensions: `.md`, `.txt`, `.ts`, `.js`, `.py`, `.json`, `.yaml`, `.yml`, `.html`, `.css`, `.csv`, `.xml`, `.sh`, `.toml`, `.ini`, `.conf`.

**Authentication:** a Dropbox access token. Generate one from the [Dropbox App Console](https://www.dropbox.com/developers/apps) by creating an app with the `files.content.read` permission.

| Field      | Description                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| Root Path  | Folder path to scope the sync (e.g., `/team-docs`). Leave blank to sync the entire account.              |
| File Types | Comma-separated file extensions to include (e.g., `.md, .txt`). Leave blank to sync all supported types. |

## Linear

Sync issues, projects, and cycles from a Linear workspace.

**Indexed:** issues by default, with optional projects (and recent updates) and cycles.

**Authentication:** a Linear personal API key. Create one under **Settings > Security & access > Personal API keys** in Linear, then paste it into the connector's **Personal Access Token** field.

| Field            | Description                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| Linear API URL   | GraphQL API base URL (default: `https://api.linear.app`)                   |
| Team IDs         | Comma-separated team IDs to scope sync (optional)                          |
| Project IDs      | Comma-separated project IDs to scope sync (optional)                       |
| Issue States     | Comma-separated issue state names (e.g. `Todo, In Progress, Done`)         |
| Include Comments | Include issue comments in indexed content (default: on)                    |
| Include Projects | Sync projects and recent project updates as documents (default: off)       |
| Include Cycles   | Sync cycles as documents (default: off)                                    |
| Batch Size       | Items fetched per request (optional, defaults to connector implementation) |

## Outline

Sync published documents from an [Outline](https://www.getoutline.com/) workspace.

**Indexed:** published documents. Both Outline cloud (`https://app.getoutline.com`) and self-hosted instances are supported.

**Authentication:** an Outline API key. Create one under **Settings > API & Apps** in your Outline workspace. Only documents the key has access to are synced.

| Field          | Description                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| Instance URL   | The base URL of your Outline workspace (e.g. `https://app.getoutline.com` or your self-hosted URL).    |
| API Key        | Your Outline API key (starts with `ol_api_`).                                                          |
| Collection IDs | Optional comma-separated list of collection IDs to sync. Leave blank to sync all accessible documents. |

## Salesforce

Sync CRM records from a Salesforce org.

**Indexed:** CRM records from a Salesforce org. By default the connector syncs `Account`, `Contact`, `Opportunity`, and `Case`. You can list other object API names in the **Objects** field, or use **Advanced Object Config JSON** to pick exact fields and associations per object.

**Authentication:** a Salesforce username, password, and security token. The password field must contain the password directly concatenated with the security token (no separator). To get the token: log in to Salesforce, click your **User Avatar > Settings**, then go to **My Personal Information > Reset My Security Token** and check your email.

| Field                          | Description                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Login URL                      | Salesforce login endpoint (default: `https://login.salesforce.com`; use `https://test.salesforce.com` for sandbox orgs) |
| Email                          | Your Salesforce username (e.g., `user@company.com`)                                                          |
| Password + Security Token      | Your Salesforce password concatenated with your security token (e.g., `MyPassword123XXYYZZ`)                 |
| Objects                        | Comma-separated Salesforce object API names to sync (e.g., `Account, Contact, Opportunity, Case`). Leave blank for the defaults. |
| Advanced Object Config JSON    | Optional JSON for precise field and association control. Overrides the Objects field when provided.          |

Example advanced config:

```json
{
  "Lead": {
    "fields": ["FirstName", "LastName", "Company", "Email"],
    "associations": { "Account": ["Name"] }
  },
  "Case": {
    "fields": ["Subject", "Status", "Priority", "Description"]
  }
}
```

`Id`, `Name`, and `LastModifiedDate` are always included automatically.

## Managing Connectors

Connectors can be managed from either the **Connectors** page or a Knowledge Base's detail page. After creation you can:

- **Toggle enabled/disabled** -- suspends or resumes the cron schedule
- **Trigger sync** -- runs an immediate sync outside the schedule
- **View runs** -- see sync history with status, document counts, and errors

## Adding New Connector Types

See [Adding Knowledge Connectors](/docs/platform-adding-knowledge-connectors) for a developer guide on implementing new connector types.
