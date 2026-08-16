---
title: "Content Encryption at Rest"
category: Administration
description: "Server-side content encryption at rest and browser-keyed locked chats"
order: 4
lastUpdated: 2026-08-16
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

This page covers two independent features:

- **Content encryption at rest** (Enterprise, disabled by default) — server-side encryption of stored conversation and tool content, covered by the sections below.
- **[Locked chats](#locked-chats)** (disabled by default) — chats encrypted under a key only the user's browser holds.

They work separately or together.

> **Enterprise feature:** Content encryption at rest requires an enterprise license. Contact sales@archestra.ai for licensing information.

Beyond [stored secrets](./platform-secrets-management), Archestra can encrypt conversation and tool content at rest. Set `ARCHESTRA_CONTENT_ENCRYPTION_SECRET` — a key separate from the stored-secrets key, so a security team can hold it in their own vault and map it to the environment variable at deploy time. Encryption and decryption are transparent; rows written before enablement are encrypted by a background sweep.

## What Is Encrypted

- LLM proxy request and response payloads — the LLM Logs records.
- Chat message bodies.
- MCP tool call arguments and results — the MCP Logs records. A tool result carries whatever the tool returned — an email inbox, for example — so it is treated as content, not metadata.
- Guardrail analyses and the unsafe context boundary, which quote the content they judged.

Metadata stays in plaintext: timestamps, model names, token counts, tool and server names, and cost figures. Statistics, cost limits, and usage metering keep working unchanged.

## Behavior Changes While Encryption Is On

- Conversation search matches titles only — message bodies are ciphertext.
- MCP log search matches server names and methods only — tool arguments and results are ciphertext.
- OTel spans stop carrying message/tool content by default — the [`ARCHESTRA_OTEL_CAPTURE_CONTENT`](./platform-deployment#observability--metrics) default flips to `false` so plaintext content does not reach the telemetry backend while the database copies are encrypted. An explicit `true` re-enables capture (see the [observability docs](./platform-observability)) and logs a startup warning.

## Enabling on a Running Deployment

Enabling takes two rollouts, so replicas never mix encrypted writes with readers that lack the key: first deploy with the key in `ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS` (decrypt-capable everywhere, writes unchanged), then move it to `ARCHESTRA_CONTENT_ENCRYPTION_SECRET`. After the second rollout finishes, run `pnpm --filter backend db:reencrypt-content` once: replicas that had not yet restarted during the rollout may have written a few plaintext rows behind the background sweep, and an explicit run always re-verifies the full table.

## Rotating the Key

Rotation is the same shape: add the new key as `..._PREVIOUS` and roll out, swap the two variables and roll out again, let the background sweep re-encrypt (or run `pnpm --filter backend db:reencrypt-content`), then drop `..._PREVIOUS`.

## Disk Headroom

Plan disk headroom before enabling. Plaintext JSONB payloads compress inside PostgreSQL (typically ~1.5–2×); ciphertext does not, and carries a further ~33% base64 overhead. Expect the `interactions`, `messages`, and `mcp_tool_calls` tables to roughly **double** on disk once encrypted, with additional transient bloat while autovacuum reclaims the pre-encryption row versions, and a WAL/backup burst on the order of the final encrypted size while the sweep runs. Size the database volume for at least 2.5× the current combined size of those tables before enabling.

## Startup Verification

On every startup Archestra verifies the configured key against previously encrypted content and aborts on a mismatch or a missing key. Unlike stored secrets, there is deliberately no accept-new-key override: chat history cannot be re-entered. Disabling encryption after enabling it is not currently supported.

## Locked Chats

A locked chat is encrypted under a key that exists only in the browser that created it. The browser generates the key, keeps it in local storage, and sends it with each request. The server uses it in memory to serve the chat and never stores it — no key the platform holds can decrypt the messages.

This is not end-to-end encryption. The server sees content while serving requests: it forwards messages to the LLM provider and runs your security policies on them. The guarantee is at rest — a database dump, a backup, or an operator with the content encryption secret cannot read a locked chat.

Locked chats are off until you configure [key escrow](#key-escrow). Escrow keeps an offline-recoverable copy of each chat's key.

Escrow is required because a locked chat encrypts its own audit trail. Without an escrowed copy, those records could be read by nobody — not even during an investigation. Remove the escrow key to turn the feature off again.

Users start a locked chat from the composer toggle. If the browser's copy of the key is lost — cleared site data, a different browser or device — the chat opens to a notice that its contents can't be read. The conversation row and its title remain visible. Without [key escrow](#key-escrow), a lost key is unrecoverable.

What changes while a locked chat is active:

- Messages are stored encrypted under the chat's own key.
- LLM request logs, MCP tool call logs, and chat errors are encrypted under the same key. Usage, cost, and model metadata stay in plaintext, so statistics, cost limits, and metering are unaffected.
- The Logs pages show those records with their content locked. Recovering it takes the escrow private key — see [Break-Glass Recovery](#break-glass-recovery).
- The title is fixed to "Locked chat" — no LLM title generation. A manual rename is stored in plaintext.
- Attachments, sandbox commands, sharing, forking, projects, and context compaction are unavailable.

### Key Escrow

Escrow wraps each new chat's key to an RSA public key whose private half your security team holds offline. Configuring it enables locked chats. Recovery is a deliberate break-glass procedure, not something the platform can do alone. Set `ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY` to an RSA public key (PEM, at least 2048 bits). Generate a keypair with:

```bash
openssl genrsa -out locked-chat-escrow.pem 4096
openssl rsa -in locked-chat-escrow.pem -pubout -out locked-chat-escrow.pub
```

Keep `locked-chat-escrow.pem` offline with your security team. Configure only the public half.

Enable escrow in its own rollout, after the release is fully deployed. Until the key is set, no replica writes a locked-chat record, so a mixed fleet never meets one it cannot read.

The wrapped key is stored on the conversation row. Archestra cannot read it — only the offline private key opens it, so a database dump holds content encrypted under one key and the key itself encrypted under another, and yields neither.

Escrow key rotation affects new chats only: each conversation stores its key wrapped to the escrow key configured at creation time.

### Break-Glass Recovery

The escrow record is a JSON blob in the conversation row's `incognito_escrow` column, holding the chat key wrapped as RSA-OAEP (SHA-256). Column names, the environment variable, and the redaction marker still carry the feature's former name, `incognito`.

Recovery happens outside the platform, with database access. The holder of the escrow private key decrypts `wrappedDek` to get the chat key, then decrypts each envelope with AES-256-GCM.

Every envelope uses an AAD of `<column>|incognito:<conversation id>`, which binds it to both the column and the chat. Use the column the value came from:

| Table | Column | AAD column part |
|---|---|---|
| `messages` | `content` | `messages.content` |
| `interactions` | `request` | `interactions.request` |
| `interactions` | `processed_request` | `interactions.processed_request` |
| `interactions` | `response` | `interactions.response` |
| `interactions` | `dual_llm_analyses` | `interactions.dual_llm_analyses` |
| `interactions` | `unsafe_context_boundary` | `interactions.unsafe_context_boundary` |
| `mcp_tool_calls` | `tool_call` | `mcp_tool_calls.tool_call` |
| `mcp_tool_calls` | `tool_result` | `mcp_tool_calls.tool_result` |
| `conversation_chat_errors` | `error` | `conversation_chat_errors.error` |

Rows in `interactions` and `mcp_tool_calls` carry the chat they belong to in `incognito_conversation_id`. Select on it to find everything one chat produced — `mcp_tool_calls` has no other reference to the conversation.

Each envelope decrypts to `{"v": <original value>}`.

A record whose content reads `{"__redacted": "incognito"}` was never stored and cannot be recovered. Archestra writes that only when it could not encrypt correctly — no key on the request, a key that did not match the chat, or a chat with no escrow record.

Plan who holds the private key and under what procedure before enabling escrow.
