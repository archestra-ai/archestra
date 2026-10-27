---
title: Secret Storage
description: Choose database or Vault storage and rotate credential encryption keys
order: 5
lastUpdated: 2026-10-27
---

Archestra encrypts saved credentials in PostgreSQL by default. Use HashiCorp Vault to keep their values outside the database. This storage protects [credentials](/docs/admin/credentials); [content encryption](/docs/admin/content-encryption) protects messages and tool results separately.

<span id="secrets-management"></span>

## Database Storage

<span id="database-storage"></span>

Keep the default database storage unless you need Vault. Archestra encrypts saved values with AES-256-GCM using a key derived from [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET).

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

HashiCorp Vault stores secret values externally instead of in the database. PostgreSQL stores each secret's metadata.

Vault storage requires an [Enterprise license](/docs/get-started/pricing-model) and a Vault identity that can create, read, update, and delete secrets, plus list their paths. For KV v2, allow listing and deletion on the metadata path too.

1. Set [`ARCHESTRA_SECRETS_MANAGER=VAULT`](/docs/admin/deployment/configuration#ARCHESTRA_SECRETS_MANAGER) and [`ARCHESTRA_HASHICORP_VAULT_ADDR`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_ADDR).
2. Configure one authentication method below on every web and worker pod, using Kubernetes Secret references for sensitive values.
3. After rollout, open **Settings → Secrets** and use **Check Vault Connectivity**. Confirm **Connection Successful** before saving credentials.

Missing or invalid required Vault configuration, or an inactive Enterprise license, logs a warning and falls back to database storage. Check the active storage after rollout.

<span id="secret-storage-paths"></span>

Set a custom storage prefix with [`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_PATH). [`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH) overrides KV v2 metadata paths.

### Vault Authentication

Choose the method matching your deployment identity using [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD).

| Method | Supply |
| --- | --- |
| `TOKEN` | [`ARCHESTRA_HASHICORP_VAULT_TOKEN`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_TOKEN). |
| `K8S` | [`ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_K8S_ROLE), bound to the workload's service account. |
| `AWS` | [`ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AWS_ROLE), bound to its AWS identity. |

The [Vault configuration entries](/docs/admin/deployment/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD) cover KV versions, custom auth mount points, token paths, and AWS endpoints.
