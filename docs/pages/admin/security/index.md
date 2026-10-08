---
title: Data Security
description: Protect stored credentials and content, and manage encryption keys
order: 7
lastUpdated: 2026-10-05
---

Archestra stores provider keys, connector credentials, conversations, and tool output. Credential storage and content encryption have separate keys and rotation procedures.

[Secrets Management](/docs/admin/security/secrets-management) covers the encryption key for saved credentials, optional Vault storage, and key rotation. Keep encryption keys in your deployment's secret manager and preserve them when restoring a database.

[Content Encryption](/docs/admin/security/content-encryption) covers encryption of conversations and tool output. [Credentials](/docs/admin/security/credentials) explains how to save reusable credentials and choose their visibility. Encryption protects stored values; [Access Control](/docs/admin/access-control) determines who can use or manage them.
