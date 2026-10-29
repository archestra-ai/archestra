---
title: "Content Encryption at Rest"
sidebarTitle: Encryption
description: Encrypt stored messages and tool results and rotate their keys
order: 6
lastUpdated: 2026-10-22
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Encrypt saved conversations, model payloads, and tool results with a deployment-held key, independently of [stored credentials](/docs/admin/credentials#secrets-storage). This is an [Enterprise feature](/docs/get-started/pricing-model), disabled by default.

[Encrypted chats](/docs/chat#encrypted-chats) instead use a browser-held key with organization escrow. Both features protect stored content; the server still processes plaintext while handling requests.

## What Is Encrypted

- LLM proxy request and response payloads — the LLM Logs records.
- Chat message bodies.
- MCP tool call arguments and results — the MCP Logs records. A tool result carries whatever the tool returned — an email inbox, for example — so it is treated as content, not metadata.
- Guardrail analyses and the unsafe context boundary, which quote the content they judged.

Metadata stays in plaintext: timestamps, model names, token counts, tool and server names, and cost figures. Statistics, cost limits, and usage metering keep working unchanged.

## Behavior Changes While Encryption Is On

- Conversation search matches titles only — message bodies are ciphertext.
- MCP log search matches server names and methods only — tool arguments and results are ciphertext.
- OTel spans stop carrying message/tool content by default — the [`ARCHESTRA_OTEL_CAPTURE_CONTENT`](/docs/admin/deployment/configuration#ARCHESTRA_OTEL_CAPTURE_CONTENT) default flips to `false` so plaintext content does not reach the telemetry backend while the database copies are encrypted. An explicit `true` re-enables capture (see the [observability docs](/docs/admin/observability)) and logs a startup warning.

## Enabling on a Running Deployment

Use two rollouts so every replica can decrypt content before any replica writes it encrypted.

1. Check [disk headroom](#disk-headroom), back up the database, and preserve the new encryption key separately from the stored-secrets key.
2. Set the new key in [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS`](/docs/admin/deployment/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS) and finish a rollout of all replicas. They can now decrypt with it while writes remain unchanged.
3. Move the key to [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/admin/deployment/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET) and finish a second rollout. New writes are encrypted, and a background sweep encrypts older rows.
4. After every replica has updated, run the sweep once more to cover plaintext written during rollout. From `/app/backend` inside an upgraded application container:

   ```bash
   node dist/standalone-scripts/reencrypt-content.ee.mjs
   ```

For a source checkout configured with the deployment's database and keys, run `pnpm --filter @backend db:reencrypt-content` from `platform/` instead. Confirm the sweep exits successfully before removing the previous key. It rechecks the full table, including rows missed during rollout.

## Rotating the Key

Keep both keys available until every replica can read the replacement.

1. Keep the current key active and put the new key in [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS`](/docs/admin/deployment/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS). Finish a rollout.
2. Swap the active and previous keys, then finish another rollout.
3. Let the background sweep finish, or run the sweep command above to verify all stored content uses the new key.
4. Remove the previous key in a later rollout.

## Disk Headroom

Before enabling encryption, provide at least **2.5×** the current combined size of the message, interaction, and tool-call tables. Encryption increases stored size and needs temporary space during the sweep. Backups and replication also need capacity for that write volume.

## Startup Verification

On every startup Archestra verifies the configured key against previously encrypted content and aborts on a mismatch or a missing key. Unlike stored secrets, there is deliberately no accept-new-key override: chat history cannot be re-entered. Disabling encryption after enabling it is not currently supported.

## Key Escrow for Encrypted Chats

<span id="key-escrow"></span>

Configure an organization escrow public key so designated key holders can recover [encrypted chats](/docs/chat#encrypted-chats) if local browser storage is lost.

Setting [`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/admin/deployment/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) enables encrypted chats across your organization. Provide an RSA public key of at least 2048 bits in PEM or base64-encoded PEM format. When enabled, the browser generates an AES key per chat and encrypts that key with your escrow public key before storing the conversation.

## Recovering an Encrypted Chat

Recovery requires the escrow **private key** and direct database access, outside Archestra. Keep that key with designated recovery operators and test your organization's recovery process before enabling encrypted chats. Archestra has no in-app recovery workflow. Content that was redacted before storage cannot be recovered.
