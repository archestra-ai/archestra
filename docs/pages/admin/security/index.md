---
title: Data Security
description: Protect stored credentials, external secrets, and encrypted content
order: 7
lastUpdated: 2026-10-15
---

Keep integration credentials encrypted and choose which conversation content the database can decrypt.

[Saved credentials](/docs/admin/security/credentials) use their own storage key and can live in PostgreSQL or an external Vault. [Content encryption at rest](/docs/admin/security/content-encryption) encrypts chat and log payloads with a separate server-held key. Browser-encrypted chats use per-chat browser-held keys and an organization escrow public key.

Preserve the keys required by each enabled mode with your recovery process. Restoring the database alone does not restore access to encrypted values.
