---
title: "Secrets management"
category: Archestra Platform
description: "Configure external secrets storage for sensitive data"
order: 6
lastUpdated: 2025-12-01
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers Vault secret manager configuration. Include:
- Overview of secret storage options (DB vs Vault)
- Environment variables
- Secret storage paths
- How the hybrid storage approach works
-->

Archestra supports external secrets storage. When enabled, sensitive data like chat API keys and MCP server credentials are stored externally.

> **Note:** Existing secrets are not migrated when you enable external storage. Recreate secrets after changing secret manager.

## HashiCorp Vault

To enable Vault secrets management, set `ARCHESTRA_SECRETS_MANAGER` to `VAULT` and configure Vault address and auth token:

| Variable | Value |
|----------|-------------|
| `ARCHESTRA_SECRETS_MANAGER` | `VAULT` |
| `HASHICORP_VAULT_ADDR` | `<Your Vault server address>`|
| `HASHICORP_VAULT_TOKEN` | `<Your Vault Authentication token>` |

> **Note:**If `ARCHESTRA_SECRETS_MANAGER` is set to `Vault` but the required environment variables are missing, the system automatically falls back to database storage.

### Secret Storage Paths

Secrets are stored using the KV secrets engine v2:

- **Data path:** `secret/data/archestra/{secretName}`


## Database Storage

Secrets are stored in the database by default.
To explicitly configure database storage, set `ARCHESTRA_SECRETS_MANAGER` to `DB`.
