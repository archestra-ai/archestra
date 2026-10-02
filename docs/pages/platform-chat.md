---
title: Chat
category: Agents
order: 2
description: Built-in Chat interface for working with agents and MCP tools
lastUpdated: 2026-10-01
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra includes a built-in Chat interface for working with agents, MCP tools, files, browser actions, and model selection in one place.

![Agent Platform Swarm](/docs/platform-chat.webp)

## Encrypted Chats

Normally, everyone who operates an Archestra deployment can read every conversation — platform admins, the DevOps team, anyone with database access. Chats are stored in the database, and the LLM and MCP logs keep a copy of each request so admins can debug and audit agents.

That doesn't work for some conversations. Executives discussing a reorganization, HR handling a complaint, or legal reviewing a deal shouldn't be readable by the people who run the platform. At the same time, the company can't allow conversations that nobody could ever audit.

Encrypted chats solve both problems. When you turn on the lock in the composer, your browser creates a secret key for that chat and keeps it. Archestra uses the key to encrypt the chat's messages, attachments, LLM and MCP logs, and errors before storing them, and never saves the key itself. Without the key, the stored data is unreadable — to admins, to the database team, and to anyone holding a backup.

![Encrypted chat composer](/docs/automated_screenshots/platform-chat_encrypted-chat-composer.webp)

Because the key lives in one browser, the chat only opens there. In another browser or on another device, the chat shows up in the list but its content can't be opened.

Encryption protects the stored data, not the conversation in progress: Archestra and your LLM provider still process the content to answer you. Features that would copy the content somewhere else are turned off in encrypted chats — sharing, forking, projects, sandbox commands, context compaction, and adding files to a knowledge base.

### Key Escrow

If the only copy of a chat key sat in one browser, clearing that browser or losing a laptop would make the chat unreadable forever — audit trail included. Key escrow prevents that.

Escrow means a trusted party holds a spare copy of a key, to be used only in an emergency. Archestra locks a copy of every chat key with a public key you configure, and only the matching private key can unlock it. You give the private key to a group the company trusts with this role — the CISO's office, for example — and they keep it offline. Archestra never has the private key, so the platform team still can't read encrypted chats. When an investigation requires it, the key holder can unlock a chat's key and read the chat.

Encrypted chats stay unavailable until escrow is configured — until then, the lock in the composer explains the feature instead of turning it on:

![Encrypted chats setup hint](/docs/automated_screenshots/platform-chat_encrypted-chat-setup.webp)

To enable them, generate a key pair, give `encrypted-chat-escrow.pem` to the key holders, and set `ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY` to the contents of `encrypted-chat-escrow.pub`:

```bash
openssl genrsa -out encrypted-chat-escrow.pem 4096
openssl rsa -in encrypted-chat-escrow.pem -pubout -out encrypted-chat-escrow.pub
```

### Recovering an Encrypted Chat

Recovery happens outside Archestra, with direct database access. Decrypt `wrappedDek` from `conversations.encrypted_chat_escrow` with the private key (RSA-OAEP, SHA-256) to get the chat key. Each encrypted value is AES-256-GCM with the AAD `<table>.<column>|incognito:<conversation id>` and decrypts to `{"v": <value>}` — except attachment bytes in `conversation_attachments.file_data`, which are raw ciphertext behind a 29-byte header (version byte, 12-byte IV, 16-byte tag). Find a chat's log rows by `encrypted_chat_conversation_id` in `interactions` and `mcp_tool_calls`. A value of `{"__redacted": …}` was never stored and can't be recovered.
