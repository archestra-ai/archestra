---
title: "Secrets Management"
category: Archestra Platform
description: "Configure external secrets storage for sensitive data"
order: 6
lastUpdated: 2025-12-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers Vault secret manager configuration. Include:
- Overview of secret storage options (DB vs Vault)
- Environment variables
- Token, Kubernetes, and AWS IAM authentication for Vault
- Secret storage paths
-->

Archestra supports external secrets storage. When enabled, sensitive data like API keys and MCP server credentials are stored externally.

> **Note:** Existing secrets are not migrated when you enable external storage. Recreate secrets after changing the secrets manager.

## HashiCorp Vault

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

To enable Vault, set `ARCHESTRA_SECRETS_MANAGER` to `VAULT` and configure the address and authentication method.

| Variable                                 | Value                     |
| ---------------------------------------- | ------------------------- |
| `ARCHESTRA_SECRETS_MANAGER`              | `VAULT`                   |
| `ARCHESTRA_HASHICORP_VAULT_ADDR`         | Your Vault server address |
| `ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`  | `TOKEN`, `K8S`, or `AWS`  |
| `ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` | Your license value        |

Configure authentication using one of the methods described in [Vault Authentication](#vault-authentication).

> **Note:** If `ARCHESTRA_SECRETS_MANAGER` is set to `VAULT` but the required environment variables are missing, the system falls back to database storage.

### Secret Storage Paths

Secrets are stored using the KV secrets engine v2:

- **Data path:** `secret/data/archestra/{secretName}`

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

**Example: Connecting the Default Team**

To connect the default team to a Vault folder at `kv/platform/ee/archestra`:

1. Navigate to **Settings** → **Teams**
2. Find the **Default** team and click the **Configure Vault Folder** button

![Teams page with Configure Vault Folder button](/docs/automated_screenshots/teams-configure-vault-folder-button.png)

3. Enter the path: `kv/platform/ee/archestra`
4. Click **Test Connection** to verify access
5. Click **Save Path**

![Team Vault Folder Configuration Dialog](/docs/automated_screenshots/vault-folder-dialog-filled.png)

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

![MCP Server Installation with Vault Secrets](/docs/automated_screenshots/mcp-server-install-vault-complete.png)

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

## Database Storage

Secrets are stored in the database by default.
To explicitly configure database storage, set `ARCHESTRA_SECRETS_MANAGER` to `DB`.

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
