---
title: "Content Encryption at Rest"
category: Administration
description: "Encrypt conversation and tool call content in the database under a separate key"
order: 4
lastUpdated: 2026-08-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

Beyond [stored secrets](./platform-secrets-management), Archestra can encrypt conversation and tool content at rest. Set `ARCHESTRA_CONTENT_ENCRYPTION_SECRET` — a key separate from the stored-secrets key, so a security team can hold it in their own vault and map it to the environment variable at deploy time. Encryption and decryption are transparent; rows written before enablement are encrypted by a background sweep.

## What Is Encrypted

- LLM proxy request and response payloads — the LLM Logs records.
- Chat message bodies.
- MCP tool call arguments and results — the MCP Logs records. A tool result carries whatever the tool returned — an email inbox, for example — so it is treated as content, not metadata.

Metadata stays in plaintext: timestamps, model names, token counts, tool and server names, and cost figures. Statistics, cost limits, and usage metering keep working unchanged.

## Behavior Changes While Encryption Is On

- Conversation search matches titles only — message bodies are ciphertext.
- MCP log search matches server names and methods only — tool arguments and results are ciphertext.
- Claude Code request delta-compression is disabled for new records, so LLM log storage grows faster. Pair encryption with [data retention](./platform-deployment#data-retention).
- OTel spans stop carrying message/tool content by default — the [`ARCHESTRA_OTEL_CAPTURE_CONTENT`](./platform-deployment#observability--metrics) default flips to `false` so plaintext content does not reach the telemetry backend while the database copies are encrypted. An explicit `true` re-enables capture (see the [observability docs](./platform-observability)) and logs a startup warning.

## Enabling on a Running Deployment

Enabling takes two rollouts, so replicas never mix encrypted writes with readers that lack the key: first deploy with the key in `ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS` (decrypt-capable everywhere, writes unchanged), then move it to `ARCHESTRA_CONTENT_ENCRYPTION_SECRET`. After the second rollout finishes, run `pnpm --filter backend db:reencrypt-content` once: replicas that had not yet restarted during the rollout may have written a few plaintext rows behind the background sweep, and an explicit run always re-verifies the full table.

## Rotating the Key

Rotation is the same shape: add the new key as `..._PREVIOUS` and roll out, swap the two variables and roll out again, let the background sweep re-encrypt (or run `pnpm --filter backend db:reencrypt-content`), then drop `..._PREVIOUS`.

## Disk Headroom

Plan disk headroom before enabling. Plaintext JSONB payloads compress inside PostgreSQL (typically ~1.5–2×); ciphertext does not, and carries a further ~33% base64 overhead. Expect the `interactions`, `messages`, and `mcp_tool_calls` tables to roughly **double** on disk once encrypted, with additional transient bloat while autovacuum reclaims the pre-encryption row versions, and a WAL/backup burst on the order of the final encrypted size while the sweep runs. Size the database volume for at least 2.5× the current combined size of those tables before enabling.

## Startup Verification

On every startup Archestra verifies the configured key against previously encrypted content and aborts on a mismatch or a missing key. Unlike stored secrets, there is deliberately no accept-new-key override: chat history cannot be re-entered. Disabling encryption after enabling it is not currently supported.

## Incognito Chats

> **Enterprise feature:** Contact sales@archestra.ai for licensing information.

An incognito chat is encrypted under a key that exists only in the browser that created it. The browser generates the key, keeps it in local storage, and sends it with each request. The server uses it in memory to serve the chat and never stores it — no key the platform holds can decrypt the messages.

This is not end-to-end encryption. The server sees content while serving requests: it forwards messages to the LLM provider and runs your security policies on them. The guarantee is at rest — a database dump, a backup, or an operator with the content encryption secret cannot read an incognito chat.

To enable, set `ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY` to an RSA public key (PEM, at least 2048 bits). Each chat's key is wrapped to this escrow key and stored with the conversation, so a security team holding the private key offline can recover a chat — recovery is a deliberate break-glass procedure, not something the platform can do alone. Generate a keypair with:

```bash
openssl genrsa -out incognito-escrow.pem 4096
openssl rsa -in incognito-escrow.pem -pubout -out incognito-escrow.pub
```

Keep `incognito-escrow.pem` offline with your security team. Configure only the public half.

Users start an incognito chat from the composer toggle. If the browser's copy of the key is lost — cleared site data, a different browser or device — the chat opens to a notice that its contents can't be read. The conversation row and its title remain visible.

What incognito changes while a chat is active:

- Messages are stored encrypted under the chat's own key; LLM request logs and MCP tool call logs keep usage and cost metadata but their content fields are redacted.
- The title is fixed to "Incognito chat" — no LLM title generation. A manual rename is stored in plaintext.
- Attachments, sandbox commands, sharing, forking, projects, and context compaction are unavailable.
- Reconnecting to an in-progress response after a page reload is unavailable; the response still completes and is saved.

Escrow key rotation affects new chats only: each conversation stores its key wrapped to the escrow key configured at creation time.

### Break-Glass Recovery

Each incognito conversation row stores `incognito_escrow`: a JSON blob with the chat key wrapped as RSA-OAEP (SHA-256). To recover a chat, the holder of the escrow private key decrypts `wrappedDek`, then decrypts each `messages.content` envelope with AES-256-GCM using the AAD `messages.content|incognito:<conversation id>`. Recovery happens outside the platform, with database access — plan who holds the private key and under what procedure before enabling the feature.
