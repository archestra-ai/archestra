# Knowledge Base Connectors

Archestra's knowledge base supports syncing content from external sources via _knowledge connectors_. Each connector periodically fetches documents and stores them for use in RAG (Retrieval-Augmented Generation) workflows.

## Supported Connectors

| Type | Label | Authentication |
|------|-------|----------------|
| `jira` | Jira | Instance URL + Email + API Token |
| `confluence` | Confluence | Instance URL + Email + API Token |
| `github` | GitHub | Personal Access Token |
| `gitlab` | GitLab | Personal Access Token |
| `servicenow` | ServiceNow | Instance URL + Username + Password |
| `notion` | Notion | Integration Token (`secret_...`) |

---

## Notion Connector

Syncs pages and databases from a Notion workspace using the official Notion REST API. No third-party SDK is required.

### Authentication

Create an **Internal Integration** in [Notion Settings → Integrations](https://www.notion.so/my-integrations) and copy the **Integration Token** (starts with `secret_`). Share the pages or databases you want to sync with the integration from within Notion.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `integrationToken` | ✅ | Notion Integration Token (`secret_...`) |
| `databaseIds` | ❌ | Comma-separated list of Notion database IDs to restrict the sync |
| `pageIds` | ❌ | Comma-separated list of explicit Notion page IDs to sync |

### Sync behaviour

1. **`pageIds` provided** — only those pages are fetched (highest priority).
2. **`databaseIds` provided** — all pages from those databases are queried via the database query API.
3. **Neither set** — full workspace search via `/search` to discover all accessible pages.

Incremental sync is supported via a `lastSyncedAt` checkpoint. Only pages edited after the checkpoint are fetched on subsequent syncs.

Block content is fetched recursively up to **3 levels deep** and converted to Markdown (headings, bullets, quotes, code blocks, etc.).

### Example (API payload)

```json
{
  "name": "Engineering Wiki",
  "type": "notion",
  "notion": {
    "integrationToken": "secret_abc123...",
    "databaseIds": ["a1b2c3d4e5f6..."],
    "pageIds": []
  }
}
```

---

## Jira Connector

Syncs issues and comments from Jira projects.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `instanceUrl` | ✅ | Jira instance URL (e.g. `https://your-org.atlassian.net`) |
| `email` | ✅ | Atlassian account email |
| `apiToken` | ✅ | Atlassian API token |
| `projectKeys` | ❌ | List of project keys to sync (e.g. `["ENG", "OPS"]`) |

---

## Confluence Connector

Syncs pages from Confluence spaces.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `instanceUrl` | ✅ | Confluence instance URL |
| `email` | ✅ | Atlassian account email |
| `apiToken` | ✅ | Atlassian API token |
| `spaceKeys` | ❌ | List of space keys to sync |

---

## GitHub Connector

Syncs repository content (README files, wikis, issues) from GitHub.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `accessToken` | ✅ | GitHub Personal Access Token |
| `repositories` | ❌ | List of `owner/repo` strings |
| `organization` | ❌ | Organization name (sync all org repos) |

---

## GitLab Connector

Syncs merge requests, issues, and wiki pages from GitLab.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `accessToken` | ✅ | GitLab Personal Access Token |
| `instanceUrl` | ❌ | Self-hosted GitLab URL (defaults to `https://gitlab.com`) |
| `groupId` | ❌ | Group ID to sync |
| `projectIds` | ❌ | List of project IDs to sync |

---

## ServiceNow Connector

Syncs knowledge articles from ServiceNow.

### Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `instanceUrl` | ✅ | ServiceNow instance URL |
| `username` | ✅ | ServiceNow username |
| `password` | ✅ | ServiceNow password |
| `tables` | ❌ | List of table names to sync (e.g. `["kb_knowledge"]`) |
