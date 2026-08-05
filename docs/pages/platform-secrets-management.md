---
title: "Secrets Management"
category: Administration
description: "Configure external secrets storage for sensitive data"
order: 4
lastUpdated: 2026-08-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<!--
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

When secrets are stored in the database, they are automatically encrypted at rest using AES-256-GCM. The encryption key is derived from your `ARCHESTRA_SECRETS_ENCRYPTION_SECRET` environment variable.

- Encryption and decryption are fully transparent — no configuration is needed beyond setting `ARCHESTRA_SECRETS_ENCRYPTION_SECRET`.
- Existing plaintext secrets are automatically migrated to encrypted format on startup.

> **Warning:** Rotating `ARCHESTRA_SECRETS_ENCRYPTION_SECRET` makes existing encrypted secrets unreadable unless they are re-encrypted under the new key. Set `ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS` to the old value and restart — the app re-encrypts stored secrets under the new key on startup (idempotent).

On every startup, Archestra verifies that the current `ARCHESTRA_SECRETS_ENCRYPTION_SECRET` still matches the key used to encrypt stored secrets. On a mismatch, startup aborts with an error that names the cause. This catches an accidental rotation — or a database restored from another environment — before it surfaces as scattered decryption failures.

To accept a rotation without re-encrypting, set `ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY=true` for one boot, then unset it; secrets encrypted with the previous key stay unreadable and must be re-entered.

See [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](./platform-deployment#authentication--security) for more info.

## Content Encryption at Rest (Enterprise)

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

Beyond stored secrets, Archestra can encrypt conversation content at rest: LLM proxy request/response payloads (the LLM Logs records) and chat message bodies. Set `ARCHESTRA_CONTENT_ENCRYPTION_SECRET` — a key separate from the stored-secrets key, so a security team can hold it in their own vault and map it to the environment variable at deploy time. Encryption and decryption are transparent; rows written before enablement are encrypted by a background sweep.

Two behaviors change while encryption is on:

- Conversation search matches titles only — message bodies are ciphertext.
- OTel spans stop carrying message/tool content by default — the [`ARCHESTRA_OTEL_CAPTURE_CONTENT`](./platform-deployment#observability--metrics) default flips to `false` so plaintext content does not reach the telemetry backend while the database copies are encrypted. An explicit `true` re-enables capture (see the [observability docs](./platform-observability)) and logs a startup warning.

**Enabling on a running deployment** takes two rollouts, so replicas never mix encrypted writes with readers that lack the key: first deploy with the key in `ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS` (decrypt-capable everywhere, writes unchanged), then move it to `ARCHESTRA_CONTENT_ENCRYPTION_SECRET`. After the second rollout finishes, run `pnpm --filter backend db:reencrypt-content` once: replicas that had not yet restarted during the rollout may have written a few plaintext rows behind the background sweep, and an explicit run always re-verifies the full table.

**Rotating the key** is the same shape: add the new key as `..._PREVIOUS` and roll out, swap the two variables and roll out again, let the background sweep re-encrypt (or run `pnpm --filter backend db:reencrypt-content`), then drop `..._PREVIOUS`.

**Plan disk headroom before enabling.** Plaintext JSONB payloads compress inside PostgreSQL (typically ~1.5–2×); ciphertext does not, and carries a further ~33% base64 overhead. Expect the `interactions` and `messages` tables to roughly **double** on disk once encrypted, with additional transient bloat while autovacuum reclaims the pre-encryption row versions, and a WAL/backup burst on the order of the final encrypted size while the sweep runs. Size the database volume for at least 2.5× the current combined size of those tables before enabling.

On every startup Archestra verifies the configured key against previously encrypted content and aborts on a mismatch or a missing key. Unlike stored secrets, there is deliberately no accept-new-key override: chat history cannot be re-entered. Disabling encryption after enabling it is not currently supported.

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
