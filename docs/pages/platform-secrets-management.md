---
title: "Secrets Management"
category: Administration
description: "Configure external secrets storage for sensitive data"
order: 3
lastUpdated: 2026-05-13
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers Vault secret manager configuration. Include:
- Overview of secret storage options (DB vs Vault)
- Environment variables
- Token, Kubernetes, and AWS IAM authentication for Vault
- Secret storage paths
-->

Archestra stores sensitive data like API keys, OAuth tokens, and MCP server credentials as secrets. By default, secrets are encrypted at rest in the database. Optionally, you can configure external secrets storage with HashiCorp Vault.

> **Note:** Existing secrets are not migrated when you enable external storage. Recreate secrets after changing the secrets manager.

## Database Storage

Secrets are stored in the database by default. To explicitly configure database storage, set `ARCHESTRA_SECRETS_MANAGER` to `DB`.

When secrets are stored in the database, they are automatically encrypted at rest using AES-256-GCM. The encryption key is derived from your `ARCHESTRA_AUTH_SECRET` environment variable.

- Encryption and decryption are fully transparent — no configuration is needed beyond setting `ARCHESTRA_AUTH_SECRET`.
- Existing plaintext secrets are automatically migrated to encrypted format on startup.

> **Warning:** Do not change `ARCHESTRA_AUTH_SECRET` after deployment. Rotating this secret will invalidate all user sessions (forcing re-login), make existing encrypted secrets unreadable, break JWT signing (JWKS private keys are encrypted with this secret), and break two-factor authentication for enrolled users.

See [`ARCHESTRA_AUTH_SECRET`](./platform-deployment#authentication--security) for more info.

## HashiCorp Vault

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

In this mode, secret values are stored in Vault instead of the database. Archestra reads, writes, and deletes them in Vault; only references to the secret paths stay in the database.

To enable Vault, set `ARCHESTRA_SECRETS_MANAGER` to `VAULT` and configure the address and authentication method.

| Variable                                          | Required | Value                                                                                  |
| ------------------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| `ARCHESTRA_SECRETS_MANAGER`                       | Yes      | `VAULT`                                                                                |
| `ARCHESTRA_HASHICORP_VAULT_ADDR`                  | Yes      | Your Vault server address                                                              |
| `ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`          | Yes      | Your license value                                                                     |
| `ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`           | No       | `TOKEN` (default), `K8S`, or `AWS`                                                     |
| `ARCHESTRA_HASHICORP_VAULT_KV_VERSION`            | No       | KV secrets engine version, `1` or `2` (default: `2`)                                   |
| `ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`           | No       | Path prefix to store secrets under (see [Secret Storage Paths](#secret-storage-paths)) |
| `ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`  | No       | Override path prefix for KV v2 metadata operations (see [Secret Storage Paths](#secret-storage-paths)) |

> **Required next step:** Set the credentials for your chosen auth method — see [Vault Authentication](#vault-authentication).

> **Note:** If `ARCHESTRA_SECRETS_MANAGER` is set to `VAULT` but the required environment variables are missing, the system falls back to database storage.

### Secret Storage Paths

Vault paths are built as `{prefix}/{secretName}` — a secret named `github_token` is written to `{prefix}/github_token`. `ARCHESTRA_HASHICORP_VAULT_SECRET_PATH` sets the prefix; its default depends on the configured KV engine version.

| KV version | Default prefix      | Resolved path                              |
| ---------- | ------------------- | ------------------------------------------ |
| `2`        | `secret/data/archestra` | `secret/data/archestra/{secretName}`   |
| `1`        | `secret/archestra`      | `secret/archestra/{secretName}`        |

For KV v2, list and delete operations use a metadata path derived from `ARCHESTRA_HASHICORP_VAULT_SECRET_PATH` by swapping `/data/` for `/metadata/` (e.g., `kv/data/platform/archestra` → `kv/metadata/platform/archestra`). Only set `ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH` when your metadata prefix doesn't follow this `/data/` ↔ `/metadata/` convention.

<!--
## Readonly Vault

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

Readonly Vault enables teams to use secrets from their organization's external HashiCorp Vault without Archestra managing those secrets. In this mode, Archestra only reads secrets from Vault at runtime—it never creates, updates, or deletes secrets in your Vault.

### Environment Configuration

To enable Readonly Vault, configure the following environment variables:

| Variable                                 | Value                     |
| ---------------------------------------- | ------------------------- |
| `ARCHESTRA_SECRETS_MANAGER`              | `READONLY_VAULT`          |
| `ARCHESTRA_HASHICORP_VAULT_ADDR`         | Your Vault server address |
| `ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`  | `TOKEN`, `K8S`, or `AWS`  |
| `ARCHESTRA_HASHICORP_VAULT_KV_VERSION`   | `1` or `2` (default: `2`) |
| `ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` | Your license value        |

Configure authentication using one of the methods described in [Vault Authentication](#vault-authentication).

### Connecting a Team to a Vault Folder

Each team in Archestra should be linked to a specific vault folder to use external secrets. Team members can then use secrets from that folder when installing MCP servers.

**Example: Connecting a Team**

To connect a team to a Vault folder at `kv/platform/ee/archestra`:

1. Navigate to **Settings** → **Teams**
2. Find your team and click the **Configure Vault Folder** button

![Teams page with Configure Vault Folder button](/docs/automated_screenshots/teams-configure-vault-folder-button.webp)

3. Enter the path: `kv/platform/ee/archestra`
4. Click **Test Connection** to verify access
5. Click **Save Path**

![Team Vault Folder Configuration Dialog](/docs/automated_screenshots/vault-folder-dialog-filled.webp)

### Using Vault Secrets with MCP Servers

Once a team is connected to a Vault folder, team members can select secrets from Vault when installing MCP servers.

**Example: Creating a GitHub MCP Server with Vault Secret**

This example shows how to install a remote GitHub MCP server using a personal access token stored in Vault at `ghtoken` with the key `token`:

1. Navigate to **MCP Catalog**
2. Find the **GitHub** MCP server and click **Install**
3. Select the team with the configured Vault folder
4. In the authentication section, select **Use Vault Secret**
5. From the **Secret** dropdown, select `ghtoken`
6. From the **Key** dropdown, select `token`
7. Complete the installation

The MCP server will now use the secret value from your Vault at runtime.

![MCP Server Installation with Vault Secrets](/docs/automated_screenshots/mcp-server-install-vault-complete.webp)

### Required Vault Permissions

Ensure your Vault policy grants Archestra read access to the configured paths:

```hcl
# For KV v2
path "<mount>/data/<path>/*" {
  capabilities = ["read", "list"]
}

path "<mount>/metadata/<path>/*" {
  capabilities = ["read", "list"]
}

# For KV v1
path "<mount>/<path>/*" {
  capabilities = ["read", "list"]
}
```
-->

## Vault Authentication

Archestra supports three authentication methods for connecting to HashiCorp Vault.

### Token Authentication

| Variable                          | Required | Description                |
| --------------------------------- | -------- | -------------------------- |
| `ARCHESTRA_HASHICORP_VAULT_TOKEN` | Yes      | Vault authentication token |

### Kubernetes Authentication

| Variable                                    | Required | Description                                                                       |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`        | Yes      | Vault role bound to the Kubernetes service account                                |
| `ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH`  | No       | Path to SA token (default: `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| `ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT` | No       | Vault K8S auth mount point (default: `kubernetes`)                                |

The K8S auth method requires a Vault role configured with a bound service account.

### AWS IAM Authentication

| Variable                                      | Required | Description                                                        |
| --------------------------------------------- | -------- | ------------------------------------------------------------------ |
| `ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`          | Yes      | Vault role bound to the AWS IAM principal                          |
| `ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT`   | No       | Vault AWS auth mount point (default: `aws`)                        |
| `ARCHESTRA_HASHICORP_VAULT_AWS_REGION`        | No       | AWS region for STS signing (default: `us-east-1`)                  |
| `ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT`  | No       | STS endpoint URL (default: `https://sts.amazonaws.com`)            |
| `ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID` | No       | Value for `X-Vault-AWS-IAM-Server-ID` header (additional security) |
