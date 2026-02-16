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

Enable the feature by setting environment variables. See [Deployment - Knowledge Graph Configuration](/docs/platform-deployment#knowledge-graph-configuration) for details.

### LightRAG Provider

[LightRAG](https://github.com/HKUDS/LightRAG) combines vector similarity search with graph-based retrieval for more accurate and contextual results.

```bash
ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER=lightrag
ARCHESTRA_KNOWLEDGE_GRAPH_LIGHTRAG_API_URL=http://lightrag:9621
ARCHESTRA_KNOWLEDGE_GRAPH_LIGHTRAG_API_KEY=your-api-key  # Optional
```

LightRAG requires:
- A running LightRAG API server
- Neo4j for graph storage
- A vector database (e.g., Qdrant) for embeddings

## Using the Knowledge Graph

Once configured, documents are automatically ingested. There are two ways to query the knowledge graph from agents:

### Built-in Query Tool (Recommended)

Archestra includes a built-in `query_knowledge_graph` tool. To use it:

1. Go to **MCP Catalog** and find "Archestra"
2. Assign the `query_knowledge_graph` tool to your profile
3. The tool will be available to agents using that profile

The tool is also automatically assigned to new profiles when a knowledge graph provider is configured.

### External MCP Server

Alternatively, add the [LightRAG MCP server](https://github.com/hnykda/mcp-server-lightrag) to your profiles for direct LightRAG access.

## Query Modes

The `query_knowledge_graph` tool supports different query modes:

| Mode | Description | Best For |
|------|-------------|----------|
| `hybrid` | Combines local and global context (default) | General queries |
| `local` | Uses only local context from the knowledge graph | Specific document lookups |
| `global` | Uses global context across all documents | Broad topic exploration |
| `naive` | Simple RAG without graph-based retrieval | Basic similarity search |
