---
title: GitHub
description: Connect GitHub documents to Knowledge and configure source access
order: 3
lastUpdated: 2026-10-27
---

Let agents answer from your GitHub repositories: "Why did we drop Redis?" finds the pull request where you decided it. The connector syncs issues, pull request discussions, and repository files.

**Indexed:** issues, pull requests, comments, and selected text files from GitHub.com or GitHub Enterprise Server. Repository file indexing defaults to Markdown and YAML files.

**Authentication:** an organization [credential](/docs/admin/credentials), or a token entered for this connector. A saved custom secret supplies a token. A saved GitHub App supplies installation credentials.

## Connecting GitHub

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **GitHub** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub API URL        | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)               |
| Owner                 | GitHub organization or username used for automatic repository discovery                          |
| Credential | Saved organization secret or GitHub App from **Settings → Credentials** |
| Repository selection | Choose **Selected repositories** or **All accessible repositories** in **Advanced**. |

## Configure Repository Settings

Sync issues from one repository and selected documentation from another, with separate settings in each repository card.

1. Open **Advanced** and choose a repository selection mode.
2. With **All accessible repositories**, configure the shared issues, pull requests, files and labels settings directly. Those settings apply to every repository the connector discovers.
3. Switching from **All accessible repositories** to **Selected repositories** does not add cards automatically. Click **Add repository**, enter its full `owner/repo` name, and configure its settings. New cards use standard settings; they do not copy the shared form.
4. When repository files are enabled, set **File Types**, **Folders** and **Exclude paths**. Save the connector, reopen **Advanced**, and check its mode and settings.

- Removing the last selected repository does not enable discovery; add a repository or choose **All accessible repositories** explicitly. Switching modes keeps each unsaved draft. Saving applies the active form. Switching to **All accessible repositories** or changing its shared settings replaces individual customizations when saved; an unchanged save preserves existing settings.
- Blank **Folders** means the whole repository; blank **Exclude paths** or **Labels to Skip** means none. Blank **File Types** uses `.md`, `.mdx`, `.yaml` and `.yml`; `*` includes every text file. Paths are repository-relative, not globs: `docs` includes `docs/guide.md`, not `docs-internal/guide.md`. Exclusions win and affect files only.
- Existing populated repository lists open as cards with their previous effective settings; existing blank lists open the shared form. Saving either mode keeps one connector. Changing selection or filters affects later syncs; it does not automatically remove previously indexed documents.

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
