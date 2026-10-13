---
title: GitLab
description: Connect GitLab documents to Knowledge and configure source access
order: 4
lastUpdated: 2026-10-05
---

Let agents answer from your GitLab issues and merge request discussions.

**Indexed:** issues, merge requests, their comments, and (optionally) Markdown files from GitLab.com or self-hosted GitLab instances. System-generated notes (assignment changes, label updates, etc.) are filtered out.

**Authentication:** a [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/).

## Connecting GitLab

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **GitLab** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                  | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| GitLab URL             | Instance URL (e.g., `https://gitlab.com` or your self-hosted URL)                  |
| Group                  | GitLab group ID or path to scope project discovery (optional)                      |
| Project IDs            | Comma-separated specific project IDs to sync (optional -- leave blank to sync all) |
| Include Issues         | Toggle to sync issues and their comments (default: on)                             |
| Include Merge Requests | Toggle to sync merge requests and their comments (default: on)                     |
| Include Markdown Files | Toggle to sync `.md` and `.mdx` files from the repository (default: off)           |

## GitLab Auto-Sync Permissions

Create a personal access token under **Edit profile > Access > Personal access tokens**. Grant only the `read_api` scope and set an expiry. The token's user needs **Reporter** or higher on every private project. Use an **Owner** of the configured top-level group for broad project discovery.

A regular token receives only `public_email`. On self-managed GitLab, an instance administrator token can read private email. Add `admin_mode` when Admin Mode is enabled. GitLab.com users without public email need [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).

Each project is one permission scope. Its audience is the project's members with the **Reporter** role or higher — direct members, members inherited from ancestor groups, and members of invited groups, each at their effective access level. Guests are excluded: GitLab does not let them read code or confidential issues, so including them would over-share. **Public** and **internal** projects are readable by everyone in your Archestra organization.
