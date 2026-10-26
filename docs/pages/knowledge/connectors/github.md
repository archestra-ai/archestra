---
title: GitHub
description: Connect GitHub documents to Knowledge and configure source access
order: 3
lastUpdated: 2026-10-26
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

Sync issues from one repository and selected documentation from another, using shared defaults for everything else.

1. Open **Advanced**. Choose **Selected repositories** and enter comma-separated names or `owner/repo` entries. Each selected repository gets a settings row. Choose **All accessible repositories** to use automatic discovery instead.
2. Expand **Repository defaults**. Set issues, pull requests and skipped labels together. Under **Repository files**, choose whether to sync files, their types, and their include/exclude paths.
3. Click **Customize** on a repository that needs different settings. Keep **Use default** selected for inherited values; change only the settings that differ. In discovery mode, **Add repository override** adds an exception without selecting an additional source repository.
4. Save the connector, reopen **Advanced**, and check each repository's summary. **Reset to defaults** removes its customization while keeping it selected.

- Inherited settings follow the defaults, including for newly discovered repositories. Explicit **Off** disables a category. Clearing the selected-repository list does not enable discovery; choose **All accessible repositories** explicitly. A qualified `owner/repo` override takes precedence over a bare name under **Owner**.
- Custom blank **Include paths** means the whole repository; blank **Exclude paths** or **Labels to Skip** means none. Blank **File Types** uses `.md`, `.mdx`, `.yaml` and `.yml`; `*` includes every text file. Paths are repository-relative, not globs: `docs` includes `docs/guide.md`, not `docs-internal/guide.md`. Exclusions win and affect files only.
- Existing connector settings remain the defaults until you change them. Changing selection or filters affects later syncs; it does not automatically remove previously indexed documents.

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
