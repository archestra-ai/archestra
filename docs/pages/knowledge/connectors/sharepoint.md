---
title: SharePoint
description: Connect SharePoint documents to Knowledge and configure source access
order: 8
lastUpdated: 2026-10-05
---

Let agents answer from SharePoint Online documents and site pages, with a link to each source.

**Indexed:** documents and site pages from SharePoint Online. Supported document types include `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log`, `.docx`, `.pdf`, and `.pptx`. When a multimodal embedding model is configured, image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) up to 4 MB are also indexed.

**Authentication:** an Azure AD app registration with client credentials (OAuth2). The app needs the `Sites.Read.All` application permission on Microsoft Graph, with admin consent granted.

## Connecting SharePoint

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **SharePoint** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

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

<!-- SPDX-SnippetBegin -->
<!-- SPDX-SnippetCopyrightText: 2026 Archestra Inc. -->
<!-- SPDX-License-Identifier: LicenseRef-Archestra-Enterprise -->
**Page publication status** limits site pages to **Published only**, **Draft only**, or **Both**. New connectors created in the UI default to Published only. Existing connectors keep Both until you change the setting. API configurations without `pagePublicationStatus` also use Both.

The filter uses the current version's status from SharePoint. Published only excludes current drafts, even when an earlier published version exists. Restricted modes exclude pages whose status is missing or unrecognized. Document library files are unaffected.

Changing the selection takes effect on the next sync. That sync removes previously indexed pages outside the selection. Later syncs also remove pages whose publication status no longer matches. <!-- SPDX-SnippetEnd -->

Where to find each value:

- **Tenant ID** — **Microsoft Entra ID > App registrations > <your app> > Overview > Directory (tenant) ID**.
- **Client ID** — Application (client) ID on the same page.
- **Client Secret** — the secret **Value** from **Certificates & secrets** (not the secret ID).
- **Site URL** — the exact SharePoint site web URL, not the display name.

## SharePoint Auto-Sync Permissions

Create one single-tenant application under **Microsoft Entra ID > App registrations**. Add a client secret under **Certificates & secrets**, then copy its **Value**. Under **API permissions**, add the application permissions below and select **Grant admin consent**:

| API | Application permission | Purpose |
| --- | --- | --- |
| Microsoft Graph | `Sites.Read.All` | Site content, libraries, items, and permission lists |
| Microsoft Graph | `User.Read.All` | User grants, emails, and organization-link audiences |
| Microsoft Graph | `GroupMember.Read.All` | Microsoft 365 and Entra group rosters |
| Microsoft Graph | `Sites.FullControl.All` | Sharing-aware delta permission scans |

Each document library is one permission scope, and an item (file or folder) that breaks permission inheritance becomes its own scope — a document inherits its nearest such ancestor. Site pages follow the site's default library audience; per-page unique sharing is not modeled. Anonymous sharing links map to everyone in your Archestra organization; "people in your organization" links expand to the tenant's active users.

Microsoft 365 and Entra group grants carry the group's identity, and each permission sync snapshots their member rosters. Direct grantees appear under the synthetic `direct-grants` group. A group granted only on a single item is not discovered by roster sync. Its grant remains fail-closed until that group also appears on a library root.

SharePoint site groups are not currently expandable. The connector accepts a client secret, while SharePoint Online requires certificate authentication for app-only REST calls. Site-group grants remain fail-closed until certificate credentials are supported.

