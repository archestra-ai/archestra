---
title: Credentials and Secrets
description: Reuse saved credentials, control who can use them, and choose encrypted storage
order: 1
lastUpdated: 2026-10-15
---

Save a repository credential once, then use it for an MCP server, a coding agent, and a Knowledge connector. The Credentials pages keep the definition and its permissions separate from the secret value.

## Credential Types

Choose the identity the integration should use.

| Type | Use it for |
| --- | --- |
| **Custom secret** | A single value, such as a personal access token. |
| **GitHub App** | Organization access to selected repositories through short-lived installation tokens. |
| **GitHub user credential** | Each person's GitHub identity, authorized through an organization-managed App. |
| **GitLab token** | Organization repository access on gitlab.com or self-managed GitLab. Add it while choosing a GitLab repository. |

For a GitHub App, provide its API URL, app ID, installation ID, and private key. Install it only on repositories the integration needs. Workloads receive an installation token, never the private key; [GitHub installation tokens expire after an hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

For personal GitHub authorization, the organization App also needs an OAuth client ID and secret. Register `<frontend URL>/settings/credentials/github/callback` as its callback and keep expiring user tokens enabled. Access is limited to permissions held by both the person and the App.

## Ownership

Choose **Each user** when an integration must act as the person using it. Choose **The organization** for shared or unattended work.

- **Each user:** every person connects a private value. Agent Runtime uses the person on the run; personal MCP installations use their owner. Archestra never substitutes another person's value.
- **The organization:** one connected value serves shared integrations, scheduled imports, and Knowledge syncs.

A GitHub App installation credential and a GitLab token belong to the organization. A GitHub user credential is personal. Create separate credential definitions when one service needs both ownership policies.

To connect your own values or add a credential for personal use, open **Settings → Credentials** if available. Otherwise, click your name in the sidebar and open **Personal Settings → Credentials**. The personal page lists the personal credentials you can access and, with Agent Runtime enabled, your Claude Code subscription.

## Who Can Manage a Credential

Share a credential definition separately from its value. For example, let a platform team rotate one GitHub App without granting access to every saved secret.

1. Open **Edit → Permissions** on the credential's row.
2. Add recipients and choose their level.
3. Save and check the recipient's level.

Use **Permissions** beside **Add credential** to grant access to every credential.

| Level | Permits |
| --- | --- |
| **Can read** | See the definition and where it is used. |
| **Can use** | Also connect a personal value or attach the credential to a resource or battery. |
| **Can update** | Also change its details and organization value. |
| **Full access** | Also delete it and manage recipients. |

Opening **Settings → Credentials** requires [`credential:read`](/docs/reference/permissions#credential:read) and one of these: a role that can add, change, or delete credentials; **Can update** or **Full access** on an organization credential; or access to another Settings page. Owning a personal credential alone does not open Settings.

Anyone can add a personal credential that only they can use. Creating a shared or organization credential requires [`credential:create`](/docs/reference/permissions#credential:create). The creator gets Full access. New shared definitions grant everyone **Can use** only when their creator has [organization-wide sharing authority](/docs/admin/access-control#granular-access-control); otherwise they start with the creator alone. Remove the Everyone grant for a team-only credential. Admin and Platform Admin have Full access to all credentials by default, as does Editor.

An attached organization value works for anyone who can use the server or agent. A personal value additionally requires **Can use** on the credential. Without that access, installation is disabled or chat reports missing credential access. See [Granular Access Control](/docs/admin/access-control#granular-access-control).

## Using Credentials

Use **Secret source** in an agent's or MCP server's environment editor to bind a saved credential to the variable the integration expects.

For example, select an organization **Custom secret** named **Repository access** for a coding agent's `GITHUB_TOKEN`, then select it for an MCP server's `GITHUB_PERSONAL_ACCESS_TOKEN`. A GitHub Knowledge connector can use the same saved credential.

A resource-specific secret serves only that resource. A saved credential is useful when several resources need the same identity. [Private repository imports](/docs/agents/skills/importing#private-repositories) and [Git sync](/docs/agents/guardrails/policies#git-sync) accept GitHub App or GitLab credentials.

After completing a conversation's credential setup link, send the original message again. Connecting credentials does not retry it automatically.

## Secrets Storage

<span id="secrets-management"></span>

Configure the storage backend through deployment variables. PostgreSQL is the default; HashiCorp Vault stores values externally. **Settings → Secrets** shows Vault connection status when that provider is configured; it does not select the storage backend.

### Database Storage

Archestra encrypts stored secret values with AES-256-GCM using [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET). Existing plaintext secrets migrate on startup.

Preserve the key alongside database backups. Database content encryption and [browser-encrypted chats](/docs/admin/security/content-encryption) use separate keys.

#### Key Rotation

Rotate the key while both the new and old key are available.

1. Set [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) to the new key.
2. Set [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS) to the old key.
3. Restart Archestra and verify re-encryption completes and integrations can resolve their credentials.
4. Remove the previous key on the next deployment.

Startup aborts if it cannot decrypt stored secrets. [`ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY`](/docs/reference/configuration#ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY) is a recovery option that accepts losing access to unmigrated values; those integrations must be reconnected.

### HashiCorp Vault

Store credential values in Vault when your organization needs external secrets storage. This requires Enterprise entitlement.

1. Set [`ARCHESTRA_SECRETS_MANAGER=VAULT`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) and [`ARCHESTRA_HASHICORP_VAULT_ADDR`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_ADDR).
2. Configure one [authentication method](#vault-authentication).
3. Restart, open **Settings → Secrets**, and check connectivity before relying on the store.

Invalid or incomplete Vault configuration logs a warning and falls back to database storage. Verify the selected provider as well as connectivity.

<span id="secret-storage-paths"></span>

Set [`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_PATH) when your Vault uses a different prefix. [`ARCHESTRA_HASHICORP_VAULT_KV_VERSION`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_KV_VERSION) selects the KV engine version; [`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH) overrides KV v2 metadata paths.

#### Vault Authentication

Choose the method matching your deployment identity using [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD).

| Method | Supply |
| --- | --- |
| Token | [`ARCHESTRA_HASHICORP_VAULT_TOKEN`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_TOKEN). |
| Kubernetes | [`ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_ROLE), bound to the workload's service account. |
| AWS IAM | [`ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_ROLE), bound to its AWS identity. |

The [Vault configuration entries](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD) cover custom auth mount points, token paths, and AWS endpoints.

## Rotation and Disconnection

Replacing a value affects future resolutions. Restart MCP processes or start a new runtime run for static environment variables.

Disconnecting removes the value, leaving its definition and bindings intact. Required bindings must be connected before execution. Deleting a referenced definition is blocked.

## Token Refresh

Managed integrations renew expiring GitHub credentials, but a custom process must reread them before authenticating.

- **MCP servers:** renewal drains existing calls and restarts the process. New calls receive a retry response while it reconnects; failed calls are never replayed automatically.
- **Agent Runtime:** the workspace stays running. The built-in Agent rereads credentials before shell commands; maintained images refresh GitHub authentication for each `gh` invocation.
- **Custom images:** implement the [credential refresh contract](/docs/agents/runtime/custom-images#refresh-credentials). Environment variables are startup snapshots.

Expired or revoked personal authorization requires reconnection. If a provider cannot renew a token, its expiry does not change: MCP calls fail and managed commands refuse expired credentials. Disconnecting a credential or canceling a run stops renewal.

<span id="use-case-one-github-credential-across-integrations"></span>
<span id="upgrading"></span>

When upgrading from resource-specific credentials, stop older replicas before the credential-store migration and start the updated application afterward. Existing references and import links carry over.
