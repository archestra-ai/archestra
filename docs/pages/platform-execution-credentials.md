---
title: Agent Execution Credentials
category: Administration
description: Define and connect credentials used by Background execution Agents
order: 5
lastUpdated: 2026-08-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Execution credentials let an Agent image request a secret without storing that secret in the Agent definition. A connection is entered once and can be used by every compatible Agent.

## Credential definitions

Admins with **Agent settings: Update** access manage definitions under **Settings → Agents → Execution credentials**.

Each definition has:

- a name, icon, and description shown to users
- a connection type: personal or organization

Archestra includes these definitions:

| Credential | Connection type | Default image binding |
| --- | --- | --- |
| GitHub PAT | Personal | `GITHUB_TOKEN` |
| Claude Code subscription | Personal | `CLAUDE_CODE_OAUTH_TOKEN` |

Create definitions for other services, such as a GitLab PAT. The name and connection type are fixed after creation; the icon and description remain editable.

## Connect values

An organization connection is set by an admin from **Settings → Agents → Execution credentials**. Everyone running an Agent bound to that connection uses the same value.

A personal connection is set under **Personal settings → Connections**. Each person supplies their own value. If a required personal connection is missing, Chat opens the same connection dialog before the first execution starts.

For GitHub, create a fine-grained token from [GitHub Developer settings](https://github.com/settings/personal-access-tokens/new). For Claude Code, run `claude setup-token` on a machine where the official Claude Code client is signed in.

Values are stored by the configured [secrets manager](/docs/platform-secrets-management). With read-only Vault enabled, the dialog selects a Vault path and key instead of accepting a pasted value.

Deleting or replacing a connection affects every Agent bound to that connection and scope. Secret values are never displayed after they are saved.

## Bind a credential to an Agent image

In the Agent editor, add a **Secret** under **Background execution** and choose:

- a credential definition for a reusable connection
- **One-off secret** for a value used only by that Agent

Set the environment variable key expected by the image. A definition can map to different keys in different images. For example, `github` can be injected as `GITHUB_TOKEN` in one image and `GH_TOKEN` in another.

Catalog Agents include useful defaults. GitHub is optional for all five maintained images. Claude Code also requires its personal subscription connection. Remove any declaration the Agent does not need.

## Bring your own image

Declare each secret the image expects in `backgroundExecution.credentials`:

```json
{
  "credentialId": "gitlab-pat",
  "key": "GITLAB_TOKEN",
  "scope": "per_user",
  "label": "GitLab PAT",
  "required": true
}
```

`credentialId` identifies the credential definition. `key` is the environment variable injected into the container. Use `scope: "per_user"` for a personal connection or `scope: "shared"` for an organization connection. Omit `credentialId` only for a one-off Agent secret.

Archestra resolves the value when an execution starts and injects it only into that execution's container. Do not bake credentials into an image or place them in command arguments, plain-text environment variables, logs, or Agent instructions.

See [Background Execution](/docs/platform-agent-background-execution) for the complete image contract.

## GitLab coding Agent

An admin creates a **GitLab PAT** definition with personal connections enabled. The Agent binds `gitlab-pat` to `GITLAB_TOKEN`. Each developer connects their own PAT once under **Personal settings → Connections**, then every compatible coding Agent can use it.
