---
title: Secret Storage
description: Choose database or Vault storage and rotate credential encryption keys
order: 4
lastUpdated: 2026-10-22
---

Archestra encrypts saved credentials in PostgreSQL by default. Use HashiCorp Vault to keep their values outside the database. This storage protects [credentials](/docs/admin/credentials); [content encryption](/docs/admin/content-encryption) protects messages and tool results separately.

<span id="secrets-management"></span>

With Vault active, **Settings → Secrets** shows its connection status. The Credentials page shows whether a value is connected, without revealing it.

## Database Storage

<span id="database-storage"></span>

Database storage is the default. To configure it explicitly, set [`ARCHESTRA_SECRETS_MANAGER`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_MANAGER) to `DB`.

Stored secrets are automatically encrypted at rest using AES-256-GCM derived from [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET).

### Key Rotation

Rotate during a maintenance window. All web pods, workers, and other processes using the database secret store must stop before any process starts with the new key. The previous key is used by the startup migration, not by ordinary secret reads; a rolling restart would mix incompatible readers and writers.

1. Back up PostgreSQL and preserve the current key.
2. Stop all application processes that read or write stored secrets.
3. Set [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) to the new key and [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS) to the old key for every process.
4. Start one application instance. Confirm its startup migration succeeds and an integration can read its credential before restoring the remaining replicas with the same configuration.
5. Remove the previous key in a later deployment, after rotation has completed.

Startup refuses a key that cannot decrypt existing secrets. Preserve the old key until rotation finishes.

## HashiCorp Vault

<span id="hashicorp-vault"></span>

HashiCorp Vault stores secret values externally instead of in the database. Only references to Vault secret paths are stored in PostgreSQL.

Set [`ARCHESTRA_SECRETS_MANAGER=VAULT`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_MANAGER), [`ARCHESTRA_HASHICORP_VAULT_ADDR`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_ADDR), and an [Enterprise license](/docs/get-started/pricing-model). Missing required configuration logs a warning and falls back to database storage. After rollout, confirm that **Settings → Secrets** appears and reports **Connection Successful**.

<span id="secret-storage-paths"></span>

Set a custom storage prefix with [`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_PATH). [`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH) overrides KV v2 metadata paths.

### Vault Authentication

Choose the method matching your deployment identity using [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD).

| Method | Supply |
| --- | --- |
| Token | [`ARCHESTRA_HASHICORP_VAULT_TOKEN`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_TOKEN). |
| Kubernetes | [`ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_ROLE), bound to the workload's service account. |
| AWS IAM | [`ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_ROLE), bound to its AWS identity. |

The [Vault configuration entries](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD) cover KV versions, custom auth mount points, token paths, and AWS endpoints.
