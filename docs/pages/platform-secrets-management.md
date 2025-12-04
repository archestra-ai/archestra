---
title: "Secrets Management"
category: Archestra Platform
description: "Configure external secrets storage for sensitive data"
order: 6
lastUpdated: 2025-12-04
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
See the documentation below for supported authentication methods and configuration instructions.

| Variable                                 | Value                            |
| ---------------------------------------- | -------------------------------- |
| `ARCHESTRA_SECRETS_MANAGER`              | `VAULT`                          |
| `ARCHESTRA_HASHICORP_VAULT_ADDR`         | Your Vault server address        |
| `ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`  | `TOKEN`, `K8S`, or `AWS`         |
| `ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED` | Your license value               |

### Token Authentication

| Variable                           | Required | Description                |
| ---------------------------------- | -------- | -------------------------- |
| `ARCHESTRA_HASHICORP_VAULT_TOKEN`  | Yes      | Vault authentication token |

### Kubernetes Authentication

| Variable                                    | Required | Description                                                                       |
| ------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| `ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`        | Yes      | Vault role bound to the Kubernetes service account                                |
| `ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH`  | No       | Path to SA token (default: `/var/run/secrets/kubernetes.io/serviceaccount/token`) |
| `ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT` | No       | Vault K8S auth mount point (default: `kubernetes`)                                |

The K8S auth method requires a Vault role configured with a bound service account. The role must have permissions to read and write secrets under `secret/data/archestra/*`.

### AWS IAM Authentication

| Variable                                        | Required | Description                                                                                      |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`            | Yes      | Vault role bound to the AWS IAM principal                                                        |
| `ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT`     | No       | Vault AWS auth mount point (default: `aws`)                                                      |
| `ARCHESTRA_HASHICORP_VAULT_AWS_REGION`          | No       | AWS region for STS signing (default: `us-east-1`)                                                |
| `ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT`    | No       | STS endpoint URL (default: `https://sts.amazonaws.com`)                                          |
| `ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID`   | No       | Value for `X-Vault-AWS-IAM-Server-ID` header (additional security)                               |

> **Note:** If `ARCHESTRA_SECRETS_MANAGER` is set to `VAULT` but the required environment variables are missing, the system falls back to database storage.

### Secret Storage Paths

Secrets are stored using the KV secrets engine v2:

- **Data path:** `secret/data/archestra/{secretName}`

## Database Storage

Secrets are stored in the database by default.
To explicitly configure database storage, set `ARCHESTRA_SECRETS_MANAGER` to `DB`.
