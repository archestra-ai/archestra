---
title: Plugins
beta: true
description: Client-native extensions for Claude Code, Codex, Copilot CLI, and Cursor
order: 4
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Give every developer the same coding-agent setup. A plugin packages hooks, subagents, slash commands, skills, and MCP settings for one coding agent. You publish it in Archestra once, and each developer installs it with one command.

Import popular plugins, such as Anthropic's [official marketplace](https://github.com/anthropics/claude-plugins-official), [Superpowers](https://github.com/obra/superpowers), and GitHub's [Awesome Copilot](https://github.com/github/awesome-copilot), or write your own. Plugins work with Claude Code, Codex, Copilot CLI, and Cursor.

![The Plugins catalog with GitHub sources, sync state, supported clients, and visibility](/docs/automated_screenshots/platform-agent-plugins_catalog.webp)

<span id="ownership"></span><span id="creating-a-plugin"></span>

## Create a Plugin

1. Go to **Plugins** and click **Add new plugin**, then **Blank template**.
2. Enter a name, and pick the target client and platforms (macOS and Linux, Windows, or both).
3. Add files. A new plugin starts with `hooks/hooks.json`, which you can replace.
4. On **Permissions**, choose who can use it, and click **Create plugin**.

Archestra stores the files as you write them. It does not convert them between clients.

<span id="importing-a-marketplace"></span>

## Import From GitHub

1. Go to **Plugins** and click **Add new plugin**.
2. Pick a popular marketplace, or paste a GitHub marketplace URL.
3. Select the plugins, preview their files, and import them.

What to know:

- **Private repositories** need a GitHub App or a personal access token from [Credentials](/docs/admin/security/credentials).
- Imported files are read-only here. Edit them in their repository. The **GitHub source** panel sets the ref, the check schedule, and the credential.
- Updates wait for you. A new commit shows **Review update**. Compare the files and click **Approve and apply**. Until then, the current files stay in use.

<span id="reviewing-updates"></span><span id="installing-plugins"></span>

## Install Plugins

Developers install plugins from a plugin's page, or pick several for one command. [Connect Your Agents](/docs/get-started/connect) can install them too, along with the gateway, the proxy, and shared skills.

What to know:

- Each install skips plugins for another client or platform.
- Codex asks before hooks run. Open `/hooks` in Codex to approve them.
- **Cursor lists installed plugins** under **Customize → Plugins**.
