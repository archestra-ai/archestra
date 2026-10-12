---
title: Importing Skills
description: Bring skills in from GitHub, GitLab, MCP servers, and plugins
order: 2
lastUpdated: 2026-10-12
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

You can bring skills in from three places:

- **Git:** import skills from a GitHub or GitLab repository and keep them in sync.
- **MCP servers:** skills that a server publishes with its tools.
- **Plugins:** skills inside a [plugin](/docs/agents/plugins).

<span id="import-from-github"></span>

## Import from GitHub or GitLab

Point Archestra at a repository, and it finds every skill folder in it, however deep. `skills/security/appsec/threat-model/` works as well as `skills/pdf/`.

1. Go to **Skills** and click **Add new skill**. Pick a popular repository, search the skill index, or click **Git repository**.
2. Pick **GitHub** or **GitLab**.
3. Pick how to sign in: a GitHub App, a GitLab token, or **Public repository** (**Public project** on GitLab).
4. Pick the repository from the list, or paste its URL. A link to a folder imports only that folder. To set a branch or folder, open **Advanced**.
5. Click **Find skills**, select the skills, pick a **Keep in sync** schedule and who can use them, and click **Import**.

![The Import skills dialog, asking whether the repository is on GitHub or GitLab](/docs/automated_screenshots/platform-agent-skills_import-from-github.webp)

A skill can have up to 500 files of up to 10 MB each. Larger files are skipped.

### Private Repositories

A private repository needs a credential that the whole organization shares:

- **GitHub:** a GitHub App installed on the repository. Add one under **Settings → Credentials**.
- **GitLab:** an access token. Click **Add a GitLab token**, and enter the GitLab URL, a name, and a project, group, or personal access token with the `read_api` scope.

Saving a credential needs [`credential:create`](/docs/reference/permissions#credential:create).

<span id="github-enterprise-server"></span>

### Self-Hosted GitHub and GitLab

Public imports work only with github.com and gitlab.com. For your own host, save a credential for it:

- **GitHub Enterprise Server:** add a GitHub App with your host's API URL, such as `https://git.example.com/api/v3`.
- **Self-managed GitLab:** add a GitLab token with your GitLab URL, such as `https://gitlab.example.com`.

Then pick that credential when you import.

### Sync

Imported skills stay in sync with their repository: every 15 minutes, every hour, or once a day (the default).

- Synced skills are read-only in Archestra. Permissions and environments stay editable.
- **Sync now** pulls right away. **Stop syncing** makes the skill editable.
- If a pull fails, the skill keeps its last good content and shows the error.

<span id="turn-github-imports-off"></span>

### Turn Git Imports Off

Set **Settings → Skills → Online skill catalog** to **Disabled**. This hides the popular repositories, the skill index, and Git imports. Existing imports keep syncing.

## Skills from MCP Servers

:::beta:::

An MCP server can publish skills with its tools. Skills from servers you can access show under the **MCP skills** filter on **Skills**. They are read-only, because the server owns them.

Archestra follows the draft [MCP skills extension (SEP-2640)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640). The same extension works the other way, too: a gateway can [publish your Archestra skills to MCP clients](/docs/mcp/gateway#publish-skills).

## Skills from Plugins

:::beta:::

Skills inside a [plugin](/docs/agents/plugins) you can read show under the **Skills from plugins** filter. They are read-only. Each one shows the client and platforms it came from, because its scripts may depend on them.

If an MCP or plugin skill has the same name as another skill, agents see it with a `-from-mcp` or `-from-plugin` suffix.
