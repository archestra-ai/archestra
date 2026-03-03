---
title: Knowledge Graphs
category: Agents
order: 6
description: Automatic document ingestion into knowledge graphs for enhanced retrieval
lastUpdated: 2025-01-15
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Archestra can automatically ingest documents uploaded via Chat into a knowledge graph. This enables graph-based retrieval augmented generation (GraphRAG) across all your organization's documents.

## How It Works

When users upload documents through the Chat interface, Archestra automatically:

1. Extracts text content from supported file types
2. Sends the content to the configured knowledge graph provider
3. The provider indexes the document for later retrieval

This happens asynchronously in the background without blocking chat responses.

## Supported File Types

Text-based documents that can be meaningfully indexed:

- **Text files**: `.txt`, `.md`, `.markdown`
- **Data formats**: `.json`, `.csv`, `.xml`, `.yaml`, `.yml`
- **Web files**: `.html`, `.htm`
- **Code files**: `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.java`, `.c`, `.cpp`, `.h`, `.hpp`, `.rs`, `.go`, `.rb`, `.php`, `.sh`, `.bash`, `.sql`, `.graphql`, `.css`, `.scss`, `.less`

Binary files (images, PDFs, etc.) are not currently supported.

## Configuration

Knowledge graphs are configured per Agent or MCP Gateway in the Archestra UI. Each Agent / MCP Gateway can be assigned a single knowledge graph.

Once assigned a knowledge graph, the `query_knowledge_graph` tool becomes available and, for Agents, documents uploaded via chat are automatically ingested into the Agent's assigned knowledge graph.

### LightRAG Provider

[LightRAG](https://github.com/HKUDS/LightRAG) combines vector similarity search with graph-based retrieval for more accurate and contextual results.

LightRAG requires:

- A running LightRAG API server
- Neo4j for graph storage
- A vector database (e.g., Qdrant) for embeddings

## Using the Knowledge Graph

### Built-in Query Tool (Recommended)

Archestra includes a built-in `query_knowledge_graph` tool. To use it:

1. Assign a knowledge graph to your Agent or MCP Gateway (see above)
2. Go to **MCP Catalog** and find "Archestra"
3. Assign the `query_knowledge_graph` tool to your agent
4. The tool will be available to agents using that profile

### External MCP Server

Alternatively, add the [LightRAG MCP server](https://github.com/brojd/lightrag-mcp) to your profiles for direct LightRAG access.

## Query Modes

The `query_knowledge_graph` tool supports different query modes:

| Mode     | Description                                      | Best For                  |
| -------- | ------------------------------------------------ | ------------------------- |
| `hybrid` | Combines local and global context (default)      | General queries           |
| `local`  | Uses only local context from the knowledge graph | Specific document lookups |
| `global` | Uses global context across all documents         | Broad topic exploration   |
| `naive`  | Simple RAG without graph-based retrieval         | Basic similarity search   |

## Connectors

Connectors are data sources that automatically ingest external content into a knowledge graph on a schedule. Instead of manually uploading documents via Chat, connectors pull data from tools your team already uses.

Each connector runs as a Kubernetes CronJob that periodically fetches new and updated content, converts it to plain text, and sends it to the knowledge graph provider. Syncs are incremental -- connectors track a checkpoint so only changes since the last run are processed.

**Requirements**: Connectors need a configured K8s runtime (`ARCHESTRA_ORCHESTRATOR_KUBECONFIG` or `ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER`).

### Supported Connectors

#### Jira

Ingests issue descriptions, comments, and metadata from Jira Cloud or Server.

| Field                   | Description                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Base URL                | Your Jira instance URL (e.g., `https://your-domain.atlassian.net`)                 |
| Cloud Instance          | Toggle on for Jira Cloud, off for Jira Server/Data Center                          |
| Project Key             | Filter issues to a single project (optional)                                       |
| JQL Query               | Custom JQL to filter issues (optional, e.g., `project = PROJ AND status = "Done"`) |
| Comment Email Blacklist | Comma-separated emails whose comments are excluded (optional)                      |
| Labels to Skip          | Comma-separated issue labels to exclude (optional)                                 |

Authentication uses an Atlassian account email and [API token](https://id.atlassian.com/manage-profile/security/api-tokens).

Incremental sync uses JQL time-range queries based on the `updated` field, so only issues modified since the last sync are fetched.

#### Confluence

Ingests page content (HTML converted to plain text) from Confluence Cloud or Server.

| Field          | Description                                                                      |
| -------------- | -------------------------------------------------------------------------------- |
| URL            | Your Confluence instance URL (e.g., `https://your-domain.atlassian.net/wiki`)    |
| Cloud Instance | Toggle on for Confluence Cloud, off for Server/Data Center                       |
| Space Keys     | Comma-separated space keys to sync (optional, e.g., `ENG, DOCS`)                 |
| Page IDs       | Comma-separated specific page IDs to sync (optional)                             |
| CQL Query      | Custom CQL to filter content (optional, e.g., `space = "ENG" AND type = "page"`) |
| Labels to Skip | Comma-separated labels to exclude (optional)                                     |
| Batch Size     | Pages per batch (default: 50)                                                    |

Authentication uses the same Atlassian email + API token as Jira.

Incremental sync uses CQL `lastModified` queries to fetch only pages changed since the last run.

### Schedules

Connectors use cron expressions to define sync frequency.

### Managing Connectors

Connectors are managed from a knowledge graph's detail page. After creation, you can:

- **Test Connection** -- verifies credentials and connectivity before waiting for the first scheduled sync
- **Trigger Sync** -- runs an immediate sync outside the schedule
- **View Runs** -- see the history of sync runs with status, documents processed, and errors
