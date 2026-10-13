---
title: Credentials and Secrets
description: Save credentials once, reuse them across integrations, and configure encrypted secrets storage
order: 1
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Credentials supply authentication to Agent Runtime, MCP servers, skills, plugins, and Knowledge connectors. Manage them under **Settings → Credentials**. Credentials are available without enabling Agent Runtime.

## Credential Types

A **Custom secret** holds one value, such as a GitHub personal access token. The integration determines how that value is used.

A **GitHub App** always belongs to the organization. It holds an API URL, app ID, installation ID, and private key. Archestra uses the private key to request an installation token. Agent and MCP environments receive the token, never the private key.

[Installation tokens expire after one hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). Archestra renews them for managed runtimes. See [Token Refresh](#token-refresh) for process behavior.

Install the GitHub App on the repositories it needs. Its installation permissions determine the token's access. Individual integrations describe their required permissions.

A **GitHub user connection** links your account to an organization-managed App. Authorize once through GitHub. Every harness using that credential acts as your GitHub user. Access is limited to permissions held by both you and the App.

The organization App needs an OAuth client ID and client secret for personal authorization. Register `<frontend URL>/settings/credentials/github/callback` as its callback URL. Keep expiring user authorization tokens enabled. Personal authorization requires writable secret storage.

User connections and bot installation credentials have separate ownership policies. Interactive coding agents can use personal connections. Unattended agents can use the organization's installation credential.

## Ownership

Every credential definition has a name, description, type, and owner policy. Its saved values are separate from that definition.

**Each user** means every person connects their own private value. Agent Runtime uses the person acting on the run. MCP servers use the owner of a personal installation. Another user's value is never substituted.

With Agent Runtime enabled, **Account → Connections** appears when a personal credential is available. Installed Claude Code agents also make the page available.

**The organization** means an administrator connects one shared value. Scheduled skill, plugin, and Knowledge syncs use organization credentials.

Create separate definitions when the same service needs both ownership policies. A personal MCP credential cannot be used by an organization installation.

## Secrets Storage

<span id="secrets-management"></span>

Saved credential values use the configured secrets manager. Archestra stores them in its PostgreSQL database by default, or in HashiCorp Vault when external secrets storage is configured. Configure your storage provider under **Settings → Secrets**.

The Credentials page displays connection status without revealing stored secrets. LLM provider accounts and native Claude subscriptions retain their dedicated sign-in flows.

### Database Storage

<span id="database-storage"></span>

Database storage is the default. To configure it explicitly, set [`ARCHESTRA_SECRETS_MANAGER`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) to `DB`.

Stored secrets are automatically encrypted at rest using AES-256-GCM derived from [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET). Existing plaintext secrets migrate to encrypted format on startup.

#### Key Rotation

To rotate the encryption key without losing access to stored secrets:

1. Set [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) to the new key.
2. Set [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS) to the old key.
3. Restart Archestra. The platform re-encrypts stored secrets under the new key on startup.
4. Remove [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS) on the next deployment.

Startup verifies the active key against stored secrets and aborts if it cannot decrypt them. To accept a new key without re-encrypting older secrets, set [`ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY=true`](/docs/reference/configuration#ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY) for one boot. Unmigrated secrets remain unreadable and must be reconnected.

### HashiCorp Vault

<span id="hashicorp-vault"></span>

HashiCorp Vault stores secret values externally instead of in the database. Only references to Vault secret paths are stored in PostgreSQL.

> [!NOTE]
> HashiCorp Vault storage requires an Enterprise license. Contact sales@archestra.ai for licensing.

Set [`ARCHESTRA_SECRETS_MANAGER`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) to `VAULT` and configure the connection parameters:

| Variable | Required | Description |
| --- | --- | --- |
| [`ARCHESTRA_SECRETS_MANAGER`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) | Yes | Set to `VAULT`. |
| [`ARCHESTRA_HASHICORP_VAULT_ADDR`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_ADDR) | Yes | Your Vault server address. |
| [`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`](/docs/reference/configuration#ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED) | Yes | Valid enterprise license key. |
| [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD) | No | `TOKEN` (default), `K8S`, or `AWS`. |
| [`ARCHESTRA_HASHICORP_VAULT_KV_VERSION`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_KV_VERSION) | No | KV secrets engine version: `1` or `2` (default: `2`). |
| [`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_PATH) | No | Path prefix to store secrets under (see [Secret Storage Paths](#secret-storage-paths)). |
| [`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH) | No | Override path prefix for KV v2 metadata operations. |

If [`ARCHESTRA_SECRETS_MANAGER`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) is set to `VAULT` but required variables are missing, Archestra logs a warning and falls back to database storage.

<span id="secret-storage-paths"></span>
Vault paths are formatted as `{prefix}/{secretName}`. The default prefix depends on the KV engine version: `secret/data/archestra` for KV v2 and `secret/archestra` for KV v1.

#### Vault Authentication

<span id="vault-authentication"></span>

Archestra supports three authentication methods for connecting to HashiCorp Vault:

- **Token**: Set [`ARCHESTRA_HASHICORP_VAULT_TOKEN`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_TOKEN).
- **Kubernetes**: Set [`ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_ROLE). Optionally customize [`ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH) and [`ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT).
- **AWS IAM**: Set [`ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_ROLE). Optionally configure [`ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT), [`ARCHESTRA_HASHICORP_VAULT_AWS_REGION`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_REGION), [`ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT), and [`ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID).

## Using Credentials

Agent Runtime and MCP environment editors share the same **Secret source** selector. Choose a saved credential and enter the variable name expected by the runtime. One credential can supply `GITHUB_TOKEN` in one resource and `GH_TOKEN` in another.

A resource-specific secret supplies only that resource. Use a saved credential when several resources need the same value.

Conversation setup links check all required credentials after GitHub authorization. Complete any remaining credentials, then send your message again in the original conversation. Connecting credentials does not automatically retry the request.

GitHub skill and plugin imports accept saved secrets as tokens or saved GitHub Apps. GitHub Knowledge connectors select an organization credential. See [Skills](/docs/agents/skills), [Plugins](/docs/agents/plugins), and [Knowledge](/docs/knowledge/connectors/github) for repository setup.

## Rotation And Disconnection

Replacing a value updates future resolutions wherever the credential is referenced. For static secrets, restart MCP processes or start a new Agent Runtime run.

Skill and Knowledge operations resolve GitHub App tokens when they authenticate. Managed runtime tokens also renew during execution. Personal GitHub connections refresh automatically while their authorization remains valid. Expired or revoked authorization requires reconnecting through GitHub.

Disconnecting removes a saved value without removing its definition. Required bindings need a connected value before execution. Deleting a definition is blocked while a resource references it.

## Token Refresh

MCP servers receive renewed tokens through a managed process restart. Existing calls finish before renewal. New calls receive a retry response while the server drains and reconnects. Shared installations renew their common process together. Failed tool calls are never replayed automatically.

Agent Runtime keeps its running process and workspace. The built-in Agent reads renewed values before each shell command. Maintained images refresh GitHub authentication for each `gh` invocation, including Git credential-helper requests.

Custom runtime code reads the file named by `ARCHESTRA_AGENT_RUNTIME_CREDENTIALS_FILE`. It contains a `taskId` and a `credentials` object keyed by environment-variable name. Each entry has a `value` and `expiresAt`, expressed in Unix milliseconds. Read the file again before authenticating, and reject expired values. Kubernetes updates this file without restarting the process.

Environment variables remain startup snapshots. A custom process that caches one token still loses access when it expires. This also applies to commands that outlive a token and keep reusing it. Start a new command or make the client reread the managed file.

Provider failures delay renewal. Tokens keep their original expiry. MCP calls fail until renewal succeeds. Managed Agent commands refuse expired or unavailable credentials. Retained interactive sessions keep renewing until workspace cleanup. Disconnecting the credential or canceling the run prevents further renewal.

## Use Case: One GitHub Credential Across Integrations

Save a GitHub token as an organization **Custom secret** named **Repository access**. Connect its value once.

Select **Repository access** for a coding Agent's `GITHUB_TOKEN` environment variable. Select it again for a GitHub MCP server's `GITHUB_PERSONAL_ACCESS_TOKEN` variable. Use the same credential for private skill imports or a GitHub Knowledge connector.

For personal repository access, create a **GitHub user connection** referencing the organization App. Each person authorizes GitHub once. Select that connection for each coding harness and personal MCP installation.

A GitHub App follows the same reuse pattern. Save its installation details, connect the private key, and select the credential in each integration.

## Upgrading

Existing GitHub tokens become custom secrets. GitHub App configurations and runtime connections move into the shared credential store. Existing secret references and skill or plugin links are preserved.

This migration requires a coordinated upgrade. Stop older application replicas before applying it. Start the updated replicas after the migration completes.
