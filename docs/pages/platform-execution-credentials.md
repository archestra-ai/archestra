---
title: Execution Credentials
category: Administration
description: Connect reusable credentials for Background execution
order: 5
lastUpdated: 2026-08-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Execution credentials keep secrets out of Agent definitions. One connection can serve every Agent that requests the same credential.

![Execution credentials in Agent settings](/docs/automated_screenshots/platform-execution-credentials_settings.webp)

## Connection Types

A personal connection belongs to one user. It runs only with executions that user starts.

An organization connection is shared. It runs with every Agent bound to that connection.

GitHub and Claude Code connections are included for personal use. You can add credentials for other services.

## Configure A Credential

Go to **Settings → Agents → Execution credentials** to add a credential. Choose who provides its value when you create it.

Connect organization values from the same section. Connect personal values under **Personal settings → Connections**. Archestra also prompts for a missing personal value when an execution starts.

Saved values are never displayed again. They use the configured [secrets manager](/docs/platform-secrets-management).

## Add A Credential To An Agent

Open the Agent editor and go to **Advanced → Background execution**. Add a **Secret**, then select a reusable connection.

Set the environment variable expected by the image. The same connection can use `GITHUB_TOKEN` in one image and `GH_TOKEN` in another.

Use **One-off secret** when the value belongs to one Agent. See [Background Execution](/docs/platform-agent-background-execution) for the image contract.

## GitLab Coding Agent

A coding Agent needs `GITLAB_TOKEN` to clone private repositories. An admin adds **GitLab** and chooses **Each user**.

The Agent binds that connection to `GITLAB_TOKEN`. Each developer connects a personal access token once under **Personal settings → Connections**.
