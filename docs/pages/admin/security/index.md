---
title: Data Security
description: Protect stored credentials, external secrets, and encrypted content
order: 7
lastUpdated: 2026-10-06
---

Archestra secures sensitive data across stored credentials, conversation logs, and tool execution outputs. Stored credentials and content encryption use distinct encryption keys and independent rotation procedures.

- [Credentials & Secrets](/docs/admin/security/credentials): Save reusable credentials, select ownership policies, and configure storage in PostgreSQL (AES-256-GCM) or HashiCorp Vault.
- [Content Encryption at Rest](/docs/admin/security/content-encryption): Enterprise server-side encryption for conversation histories, LLM proxy logs, and MCP tool call payloads.
- [Access Control](/docs/admin/access-control): Configure roles, permissions, and team scoping to control who can manage and use stored credentials.
