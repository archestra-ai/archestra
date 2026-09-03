---
title: Plugins
category: Agents
order: 4
description: Client-native extensions for Claude Code, Codex, Copilot CLI, and Cursor
lastUpdated: 2026-09-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A plugin installs client-native files on a developer machine. It can include hooks, agents, commands, skills, MCP configuration, and scripts.

Review every file before you approve an import or update.

![The Plugins catalog with GitHub sources, sync state, supported clients, and visibility](/docs/automated_screenshots/platform-agent-plugins_catalog.webp)

> **Beta feature** — set `ARCHESTRA_PLUGINS_ENABLED=true`, or enable the `ARCHESTRA_BETA` switch. See [Deployment](/docs/platform-deployment#skills-marketplace).

Go to **Studio → Plugins** to create or import a plugin.

## Creating a Plugin

You can start from a blank template or import a GitHub marketplace.

A blank plugin starts with `hooks/hooks.json`. Hooks are optional. You can replace that file with any payload the target client supports.

The plugin form is one page: what the plugin is, the files it installs, and who can discover it. Every plugin has a page of its own that shows the same form. Change anything there and **Save changes** — there is no separate edit screen to open.

Every plugin targets one client: Claude Code, Codex, Copilot CLI, or Cursor. It also declares macOS/Linux, Windows, or both, so a setup command skips an incompatible payload.

The platform stores plugin files without translating them.

## Importing a Marketplace

Import from a popular marketplace, or paste a GitHub marketplace URL. Private repositories use a GitHub App or personal access token from **Settings → GitHub**.

Select the plugins you want and preview their files. GitHub-owned files stay read-only here. Edit them in their repository.

An imported plugin's page shows those files locked, with a **GitHub source** panel underneath. Change the repository, the ref, the check schedule, or the credential there.

## Reviewing Updates

A changed GitHub commit becomes an update candidate. Approved files never change until you review the candidate and apply it.

## Installing Plugins

Install a plugin from its details page, or select several compatible ones for one command.

The [Connection page](/docs/platform-connection) can install plugins with the MCP gateway, LLM proxy, and shared Skills.

| Client | Installation |
| --- | --- |
| Claude Code | Registers the marketplace and installs each selected plugin. |
| Codex | Installs each plugin. Open `/hooks` to approve delivered hooks before they run. |
| Copilot CLI | Registers the marketplace and installs each selected plugin. |
| Cursor | Registers the marketplace, then lists the plugins under **Customize → Plugins**. |

## Use Case: Block Commits on Main

A platform engineer wants every Claude Code session to reject commits on `main`. They keep the hooks in GitHub:

```text
developer-policy/
├── hooks/hooks.json
├── scripts/check-branch.sh
└── scripts/check-branch.ps1
```

They import the repository, review the hooks, and share the plugin with the team. Each engineer runs the setup command. The next time someone tries to commit on `main`, Claude Code blocks it deterministically.
