---
title: Credentials
description: Save and share credentials across integrations
order: 5
lastUpdated: 2026-10-22
---

Save a credential once and reuse it in agents, MCP servers, skills, and Knowledge connectors. Each integration can use your personal account or an organization identity.

## Add a Credential

1. Open **Settings → Credentials**, or **Personal Settings → Credentials** if Settings is unavailable.
2. Click **Add credential**, name it, and choose its type and ownership.
3. Save its definition, then **Connect** the value. GitHub user credentials open GitHub authorization; other types ask for the secret or private key. With Vault storage, select the external secret instead.
4. Confirm the credential shows **Connected** before binding it to a resource.

For an existing credential, use **Connect** on its row. Connecting from a conversation setup link does not retry the message; send it again after setup finishes.

<span id="ownership"></span>

## Choose the Identity

| Ownership | Who acts downstream |
| --- | --- |
| Each user | The person running a coding agent, or the owner of a personal MCP installation. Each person connects their own value. |
| The organization | One shared identity, including unattended skill, plugin, and Knowledge syncs. |

A personal value cannot serve an organization MCP installation. Running a coding agent with an organization credential requires [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update); service accounts instead need use access to the credential.

## Credential Types

| Type | Use it for |
| --- | --- |
| Custom secret | A token or other single value expected by the integration. |
| GitHub App | Organization repository access within the App's installed permissions. Integrations receive installation tokens, never its private key. |
| GitHub user credential | A person's access through an organization App, limited by both the person and App's permissions. |
| GitLab token | [Private repository imports](/docs/agents/skills/importing#private-repositories), plugins, and [Git sync](/docs/agents/guardrails/git-sync), on gitlab.com or self-managed GitLab. |

For a GitHub App, supply its API URL, app ID, installation ID, and private key. Personal GitHub authorization also requires its OAuth client ID and secret, the callback `<frontend URL>/settings/credentials/github/callback`, expiring user tokens, and writable secret storage. Use separate definitions for personal and organization identities.

<span id="who-can-manage-a-credential"></span>

## Share a Credential

Open **Edit → Permissions** on its row. **Can use** lets someone connect their personal value and bind the credential; **Can update** also lets them change an organization value. **Full access** includes deletion and sharing. See [Access Control](/docs/admin/access-control#share-a-resource).

Adding a shared or organization credential requires [`credential:create`](/docs/reference/permissions#credential:create). Review its permissions after creation: shared credentials can start available to everyone at **Can use**.

<span id="using-credentials"></span>

## Use a Credential

In a coding agent or MCP server's environment editor, choose the credential under **Secret source** and enter the variable name the runtime expects. The same credential can supply `GITHUB_TOKEN` in one resource and `GH_TOKEN` in another. Binding requires **Can use**.

For repository integrations, follow [Skills](/docs/agents/skills/importing#private-repositories), [Plugins](/docs/agents/plugins), or [GitHub Knowledge](/docs/knowledge/connectors/github). Knowledge connectors require an organization credential.

<span id="rotation-and-disconnection"></span>

<span id="token-refresh"></span>

## Replace or Disconnect a Value

Replacing a value updates future resolutions. Restart static-secret MCP processes or start a new coding agent run to pick it up.

Expiring GitHub credentials renew automatically while authorization remains valid. MCP servers drain active calls and restart; coding agent workspaces keep running. Custom images must follow the [credential refresh contract](https://github.com/archestra-ai/archestra/blob/main/platform/docker_images/agent/runtime-contract.md). Expired or revoked authorization requires reconnecting, and failed calls are not replayed.

**Disconnect** removes the value but keeps its definition. Deleting a definition is blocked while resources reference it.

<span id="database-storage"></span><span id="hashicorp-vault"></span><span id="secret-storage-paths"></span><span id="secrets-management"></span>

## Secrets Storage

Values are encrypted in PostgreSQL by default. Operators configure Vault storage and encryption-key rotation in [Secret Storage](/docs/admin/deployment/secret-storage).



<span id="key-rotation"></span>


<span id="upgrading"></span>
<span id="vault-authentication"></span>
<span id="use-case-one-github-credential-across-integrations"></span>
