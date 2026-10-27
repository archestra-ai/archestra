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
| Owner                 | GitHub organization or username that owns the repositories                                      |
| Credential | Saved organization secret or GitHub App from **Settings → Credentials** |
| Repository selection | Choose **Selected repositories** or **All accessible repositories** in **Advanced**. |

## Configure Repository Settings

Sync issues from one repository and selected documentation from another, with separate settings in each repository card.

1. Open **Advanced** and choose **Selected repositories**. Click **Add repository** and enter a name or `owner/repo` in its card. Choose **All accessible repositories** to use automatic discovery instead.
2. Open a repository card. Set **Include Issues**, **Include Pull Requests**, **Include Repository Files** and **Labels to Skip** for that repository.
3. When repository files are enabled, set **File Types**, **Folders** and **Exclude paths** in the same card. Add or remove repository cards as needed.
4. Save the connector, reopen **Advanced**, and check each repository's settings. In discovery mode, the **All repositories** card configures discovered repositories; named cards configure individual exceptions.

- Removing the last selected repository does not enable discovery; add a repository or choose **All accessible repositories** explicitly. Existing settings prefill the cards. A qualified `owner/repo` rule takes precedence over a bare name under **Owner**.
- Blank **Folders** means the whole repository; blank **Exclude paths** or **Labels to Skip** means none. Blank **File Types** uses `.md`, `.mdx`, `.yaml` and `.yml`; `*` includes every text file. Paths are repository-relative, not globs: `docs` includes `docs/guide.md`, not `docs-internal/guide.md`. Exclusions win and affect files only.
- Changing selection or filters affects later syncs; it does not automatically remove previously indexed documents.

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
