---
title: OneDrive
description: Connect OneDrive documents to Knowledge and configure source access
order: 9
lastUpdated: 2026-10-05
---

Let agents answer from the OneDrive for Business drives of the people you pick. Text, Office documents, and PDFs are indexed. Images up to 4 MB are indexed when the [embedding model accepts image input](/docs/knowledge#image-embedding).

## Connecting OneDrive

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **OneDrive** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field         | Description                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tenant ID     | Your Azure AD (Entra ID) tenant ID or domain (e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)                        |
| Client ID     | Azure AD app registration Application (client) ID                                                                    |
| Client Secret | Azure AD app registration client secret value                                                                        |
| User IDs      | Comma-separated list of user principal names or object IDs whose OneDrive to sync (e.g., `reader@example.com`)       |
| Folder ID     | Restrict sync to a specific OneDrive folder (optional -- find the ID from the Graph API or a drive item URL)         |
| File Types    | Comma-separated file extensions to include, e.g. `.pdf, .docx` (optional -- leave blank for all supported types)  |
| Recursive     | Traverse subfolders within each user's drive (default: on)                                                          |

Authentication uses an Azure AD app registration with client credentials (OAuth2). The app registration requires the `Files.Read.All` application permission on Microsoft Graph, and admin consent must be granted.

Find **Tenant ID** and **Client ID** under **Microsoft Entra ID → App registrations → your app → Overview**. Copy the client secret **Value** under **Certificates & secrets**, not the secret ID. Enter user principal names or object IDs in **User IDs**.
## OneDrive Auto-Sync Permissions

Create one single-tenant application under **Microsoft Entra ID > App registrations**. Add a client secret and copy its **Value**. Add these Microsoft Graph application permissions, then grant tenant-wide admin consent:

- `Files.Read.All` reads drive content and item permissions.
- `User.Read.All` resolves owners and direct user grants to emails.
- `GroupMember.Read.All` expands Microsoft 365 and Entra groups.
- `Sites.FullControl.All` enables sharing-aware delta permission scans.

Each configured user's drive is one permission scope, and an item (file or folder) that breaks permission inheritance becomes its own scope — a document inherits its nearest such ancestor. The drive's owner is always part of its audience. Anonymous sharing links map to everyone in your Archestra organization; "people in your organization" links expand to the tenant's active users.

Only groups granted on drive roots are expanded. A Microsoft 365 or Entra group granted only on a uniquely shared item gets no roster and remains fail-closed; manual assignment cannot repair it. Direct grantees appear under the synthetic `direct-grants` group. SharePoint site groups on personal drives also resolve no members and remain fail-closed.

## Known Limitations

- Only OneDrive for Business (work/school accounts) is supported. Consumer OneDrive is not supported.
- Syncs the personal drive (`/drive`) of each specified user; shared libraries are not traversed.
