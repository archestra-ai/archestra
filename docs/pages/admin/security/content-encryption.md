---
title: "Content Encryption at Rest"
description: "Server-side encryption of stored conversation and tool content"
order: 1
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Content encryption at rest (Enterprise, disabled by default) encrypts stored conversation and tool content on the server. To keep individual chats private from the team that runs Archestra, see [Encrypted Chats](/docs/chat#encrypted-chats) — the two features work separately or together.

> **Enterprise feature:** Content encryption at rest requires an enterprise license. Contact sales@archestra.ai for licensing information.

Beyond [stored secrets](/docs/admin/security/secrets-management), Archestra can encrypt conversation and tool content at rest. Set [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET) — a key separate from the stored-secrets key, so a security team can hold it in their own vault and map it to the environment variable at deploy time. Encryption and decryption are transparent; rows written before enablement are encrypted by a background sweep.

## What Is Encrypted

- LLM proxy request and response payloads — the LLM Logs records.
- Chat message bodies.
- MCP tool call arguments and results — the MCP Logs records. A tool result carries whatever the tool returned — an email inbox, for example — so it is treated as content, not metadata.
- Guardrail analyses and the unsafe context boundary, which quote the content they judged.

Metadata stays in plaintext: timestamps, model names, token counts, tool and server names, and cost figures. Statistics, cost limits, and usage metering keep working unchanged.

## Behavior Changes While Encryption Is On

- Conversation search matches titles only — message bodies are ciphertext.
- MCP log search matches server names and methods only — tool arguments and results are ciphertext.
- OTel spans stop carrying message/tool content by default — the [`ARCHESTRA_OTEL_CAPTURE_CONTENT`](/docs/reference/configuration#ARCHESTRA_OTEL_CAPTURE_CONTENT) default flips to `false` so plaintext content does not reach the telemetry backend while the database copies are encrypted. An explicit `true` re-enables capture (see the [observability docs](/docs/admin/observability)) and logs a startup warning.

## Enabling on a Running Deployment

Enabling takes two rollouts, so replicas never mix encrypted writes with readers that lack the key: first deploy with the key in [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS`](/docs/reference/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS) (decrypt-capable everywhere, writes unchanged), then move it to [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET). After the second rollout finishes, run `pnpm --filter backend db:reencrypt-content` once: replicas that had not yet restarted during the rollout may have written a few plaintext rows behind the background sweep, and an explicit run always re-verifies the full table.

## Rotating the Key

Rotation is the same shape: add the new key as `..._PREVIOUS` and roll out, swap the two variables and roll out again, let the background sweep re-encrypt (or run `pnpm --filter backend db:reencrypt-content`), then drop `..._PREVIOUS`.

## Disk Headroom

Plan disk headroom before enabling. Plaintext JSONB payloads compress inside PostgreSQL (typically ~1.5–2×); ciphertext does not, and carries a further ~33% base64 overhead. Expect the `interactions`, `messages`, and `mcp_tool_calls` tables to roughly **double** on disk once encrypted, with additional transient bloat while autovacuum reclaims the pre-encryption row versions, and a WAL/backup burst on the order of the final encrypted size while the sweep runs. Size the database volume for at least 2.5× the current combined size of those tables before enabling.

## Startup Verification

On every startup Archestra verifies the configured key against previously encrypted content and aborts on a mismatch or a missing key. Unlike stored secrets, there is deliberately no accept-new-key override: chat history cannot be re-entered. Disabling encryption after enabling it is not currently supported.

## Recovering an Encrypted Chat

[Encrypted chats](/docs/chat#encrypted-chats) use a separate, browser-held key per chat. A key holder recovers one outside Archestra, with the escrow private key and direct database access:

1. Read `wrappedDek` from `conversations.encrypted_chat_escrow`. Decrypt it with the private key (RSA-OAEP, SHA-256) to get the chat key.
2. Decrypt each value with AES-256-GCM. The AAD is `<table>.<column>|incognito:<conversation id>`. Each value decrypts to `{"v": <value>}`.
3. Attachment bytes in `conversation_attachments.file_data` are raw ciphertext behind a 29-byte header: a version byte, a 12-byte IV, and a 16-byte tag.
4. Find the chat's log rows by `encrypted_chat_conversation_id` in `interactions` and `mcp_tool_calls`.

A value of `{"__redacted": …}` was never stored and cannot be recovered.
