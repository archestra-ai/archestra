---
title: GitHub
description: Connect GitHub documents to Knowledge and configure source access
order: 3
lastUpdated: 2026-10-05
---

Let agents answer from your GitHub repositories: "Why did we drop Redis?" finds the pull request where you decided it. The connector syncs issues, pull request discussions, and repository files.

**Indexed:** issues, pull requests, comments, and selected text files from GitHub.com or GitHub Enterprise Server. Repository file indexing defaults to Markdown and YAML files.

**Authentication:** an organization [credential](/docs/admin/security/credentials), or a token entered for this connector. A saved custom secret supplies a token. A saved GitHub App supplies installation credentials.

## Connecting GitHub

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **GitHub** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub API URL        | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)               |
| Owner                 | GitHub organization or username that owns the repositories                                      |
| Credential | Saved organization secret or GitHub App from **Settings → Credentials** |
| Repositories          | Comma-separated repository names to sync (optional -- leave blank to sync all org repositories) |
| Include Issues        | Toggle to sync issues and their comments (default: on)                                          |
| Include Pull Requests | Toggle to sync pull requests and their comments (default: on)                                   |
| Include Repository Files | Toggle to sync repository files (default: off)                                               |
| File Types            | Comma-separated file extensions to index when repository files are enabled (defaults to `.md`, `.mdx`, `.yaml`, `.yml`) |
| Folders               | Comma-separated folders to index, relative to the repository root (optional -- leave blank to index the whole repository) |

## GitHub Auto-Sync Permissions

A GitHub App is the preferred credential. Create one under **Settings > Developer settings > GitHub Apps** with these read-only permissions:

| Permission type | Read permission |
| --- | --- |
| Repository | Administration, Issues, Pull requests, and Metadata |
| Repository, when files are indexed | Contents |
| Organization | Members |

Install the App on every target repository. Generate a private key and copy its PEM value. Save the App ID, installation ID, API URL, and private key under **Settings → Credentials**, then select that configuration in the connector.

A fine-grained personal access token needs the same repository and organization permissions. Select every target repository. Its owner also needs write, maintain, or admin access to list collaborators. A classic token needs `repo` and `read:org`; authorize it for SAML SSO when the organization requires SSO.

GitHub exposes only each user's public profile email. No App or token permission reveals a private email, so those users need [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).
