---
title: Knowledge Graphs
category: Archestra Platform
order: 8
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

Once configured, documents are automatically ingested. To query the knowledge graph from agents, add the [LightRAG MCP server](https://github.com/hnykda/mcp-server-lightrag) to your profiles.

The MCP server provides tools for:
- Querying documents using natural language
- Searching with different retrieval modes (local, global, hybrid)
