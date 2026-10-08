---
title: Google Drive
description: Connect Google Drive documents to Knowledge and configure source access
order: 10
lastUpdated: 2026-10-05
---

Let agents answer from Google Docs, Sheets, and other files in My Drive and Shared Drives. Each person can find only the files Drive lets them open, depending on how you connect.

**Indexed:** files from My Drive and Shared Drives. Supported document types include `.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.htm`, `.yaml`, `.log`, `.docx`, `.pdf`, and `.pptx`. Google Workspace files (Docs, Sheets, Slides) are also indexed. When a multimodal embedding model is configured, image files (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`) are indexed too. Files larger than 10 MB are skipped.

**Authentication:** pick one of three modes. The mode decides which Google identity the connector acts as, and so what it can index.

| Mode                        | What it indexes                                                    | Who signs in to Google    | The catch                                                              |
| --------------------------- | ------------------------------------------------------------------ | ------------------------- | ---------------------------------------------------------------------- |
| **Google Workspace domain** | Every shared drive, plus every user's My Drive, across your domain | Nobody                    | A super admin has to authorize delegation once, in the Admin console   |
| **One Google account**      | Whatever that one person can already see in Drive                  | That person, once         | Without source permission sync, the connector’s visibility sets who can retrieve that data  |
| **Service account only**    | Only what has been shared with the key's own address               | Nobody                    | Somebody has to share every folder with it, by hand, forever           |

Use the Workspace domain mode if you have a Workspace tenant -- coverage keeps up with the organization on its own. Reach for one Google account when a single person's Drive is the corpus, or when nobody can change Admin console settings. Service account only suits a small, fixed set of folders somebody is willing to maintain.

## Google Workspace Domain

A service account with domain-wide delegation impersonates users across your domain. Coverage follows the organization -- a drive created next week is picked up by the next sync, with nobody sharing anything by hand.

In the [Google Cloud Console](https://console.cloud.google.com/), create a service account, enable the Google Drive API and the Admin SDK API, and download the JSON key. Copy the service account's client ID from its **Advanced settings**.

In the [Google Admin console](https://admin.google.com/), go to **Security > Access and data control > API controls > Domain-wide delegation**. Add that client ID with the two base scopes:

```text
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
```

Paste the JSON key into the connector and enter a Workspace admin address as the **Delegated admin email**. Setting a Folder ID or Drive IDs scopes the sync to those instead, and the connector then acts as that one admin.

## One Google Account

Someone authorizes their own Drive through Google, and the connector indexes what they can see. Archestra stores a refresh token, so the sync keeps working once the first hour is up.

Only that one person authorizes -- whoever sets the connector up. Nobody else signs in to Google, and there is no per-user prompt. Without auto-sync permissions, what they can see becomes readable by everyone with use access to the connector. Pick the account whose Drive access matches the intended audience.

This mode needs a Google OAuth client on the deployment. Create a **Web application** client in the Cloud Console, enable the Google Drive API, and register the redirect URI the connector form shows you. Set [`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID) and [`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET) to that client's credentials.

Saving the connector sends you to Google. The connector page then names the connected account and offers **Reconnect** -- you need it if that account ever revokes access.

## Service Account Only

The connector sees only what someone has shared with the service account's email address. Create the service account and key as above, then share each target folder or drive with that address.

## Connecting Google Drive

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **Google Drive** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                 | Description                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delegated admin email | Workspace admin the service account impersonates (Google Workspace domain mode)                                                                             |
| Drive IDs             | Comma-separated shared drive IDs to sync (optional -- providing Drive IDs automatically enables shared-drive API access; leave blank to sync from My Drive) |
| Folder ID             | Restrict sync to a specific folder (optional -- find the ID in the folder's Google Drive URL)                                                               |
| File Types            | Comma-separated file extensions to include, e.g. `.pdf, .docx` (optional -- leave blank for all)                                                            |
| Recursive Traversal   | Sync files from all nested subfolders when a Folder ID is set (default: on)                                                                                 |

**Test connection** checks the setup rather than just the credential. It confirms that impersonation works for the delegated admin, that the directory can be read when the sync will enumerate one, and that any folder or shared drive you named is reachable. The result says which of those failed.

## Google Drive Auto-Sync Permissions

Use **Google Workspace domain** mode to resolve users and Google Groups. In addition to the two base scopes above, authorize `https://www.googleapis.com/auth/admin.directory.group.readonly` for group and group-member reads. The delegated account needs directory privileges to read users, groups, and group members. **Test connection** checks the base scopes but does not validate the group-directory scope.

Domain mode currently indexes every user's Drive, but permission sync lists files only as the delegated admin. Files visible only while impersonating another user remain fail-closed. Do not use domain-wide auto-sync permissions until per-user permission enumeration is supported.

For files the delegated admin can see, direct user grants resolve from the email in the permission list and group grants expand through the Admin SDK directory. Nested groups are not inherited into their parent roster; flatten the parent group upstream, or grant the child group or users directly.

**One Google account** and **Service account only** modes cannot read the Workspace directory. Their direct user grants work, but Google Group grants remain unresolved and fail closed.
