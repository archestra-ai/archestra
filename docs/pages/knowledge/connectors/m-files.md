---
title: M-Files
description: Connect M-Files documents to Knowledge and configure source access
order: 17
lastUpdated: 2026-10-05
beta: "Set [`ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED) to turn it on."
---

Let agents answer from the documents in an M-Files vault, with each file's M-Files permissions. The connector syncs versioned files.

**Indexed:** supported files attached to the configured M-Files object types. The default object type is `0` (documents). Text, Markdown, CSV, JSON, XML, HTML, YAML, Office documents, and PDFs are indexed; supported images are indexed when a multimodal embedding model is configured. Files larger than 25 MB are skipped.

**Authentication:** a dedicated M-Files login account. Login accounts exchange a username and password for short-lived MFWS tokens.

## Connecting M-Files

1. Go to **Knowledge → Connectors** and click **Create Connector**. Select **M-Files** and name the connector.
2. Enter the credentials and connection values below. Open **Advanced** to limit the sources you sync.
3. Choose the connector visibility and sync schedule. For source-based access, follow this page’s **Auto-Sync Permissions** setup before enabling that option.
4. Click **Create Connector**. Open the connector, use **Test Connection**, and check its first document sync run. A completed run with indexed documents confirms the source is searchable.

| Field | Description |
| --- | --- |
| M-Files Web Service URL | Classic Web/MFWS base URL; `/REST` is appended automatically (for example, `https://mfiles.example.com/m-files`) |
| Vault GUID | GUID of the vault to index |
| Username | Dedicated M-Files login account for the connector |
| Password | That account's password; exchanged for a short-lived MFWS token |
| Windows Domain | Optional, under Advanced — only for domain-authenticated accounts |

Three more settings exist on the connector config and are tuned through the API rather than the form: `objectTypeIds` (managed object types, default `0`), `batchSize` (documents per indexing batch, default `50`) and `permissionExtensionMethod` (the installed VAF extension-method name, default `ArchestraKnowledgePermissionSnapshot`). Leaving them unset keeps the backend defaults.

## M-Files Auto-Sync Permissions

Install the VAF Add On below before creating the connector. In M-Files Admin, add a dedicated login account to the vault and grant **Change full control of vault**. Also grant read access to every configured object, version, and file. The administrative role permits add-on calls but does not grant content visibility by itself.

The add-on returns user and group rosters. Accounts without an email stay unresolved and need [manual assignment](/docs/knowledge/connectors#credentials-and-email-resolution).

## M-Files VAF Add On

The Archestra VAF Add On is a vault application for M-Files Server. Syncing requires it. MFWS does not expose change tracking, exact permission reads, or group membership — the add-on supplies them from inside the vault. File content never flows through it. Every call requires the **Change full control role**, enforced by M-Files itself. Unreadable permissions fail closed.

Install it once per connected vault, from the connector form:

- **Installation script** — copy the one-line command and run it in PowerShell on the M-Files server as a system administrator. It downloads the add-on, installs it into the vault you choose, and restarts the vault.
- **Manual installation** — download the `.mfappx` package and install it in M-Files Admin: right-click the vault, then Applications, then Install.
