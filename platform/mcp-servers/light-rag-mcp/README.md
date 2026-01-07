# LightRAG MCP Server

A Model Context Protocol (MCP) server for [LightRAG](https://github.com/HKUDS/LightRAG) - Simple and Fast Retrieval-Augmented Generation with knowledge graphs.

## Features

- **Document Management**: Insert, upload, and batch process documents
- **Semantic Queries**: Query documents using LightRAG's hybrid search (local, global, hybrid, naive, mix modes)
- **Knowledge Graph Operations**: Create, edit, delete, and merge entities and relationships
- **Multi-Provider LLM Support**: OpenAI, Anthropic (Claude), Google Gemini
- **Flexible Storage**: Neo4j + Qdrant for production, or local file storage for development
- **Health Monitoring**: Check system and component health

## Quick Start

### Minimal Setup (Local File Storage)

```bash
# Clone the repository
git clone https://github.com/archestra-ai/archestra.git
cd platform/mcp-servers/light-rag-mcp

# Run with Docker (minimal - just needs LLM API key)
docker run -d -p 8080:8080 \
  -e LIGHTRAG_LLM_API_KEY=sk-your-openai-key \
  -v lightrag-data:/app/data \
  archestra/light-rag-mcp:latest

# MCP server available at http://localhost:8080/mcp
```

### Full Setup with Neo4j + Qdrant

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your API keys
# LIGHTRAG_LLM_API_KEY=sk-your-key

# Start all services
docker-compose up -d

# MCP server: http://localhost:8080/mcp
# Neo4j Browser: http://localhost:7474
# Qdrant Dashboard: http://localhost:6333/dashboard
```

## MCP Tools

### Document Queries

| Tool | Description |
|------|-------------|
| `query_document` | Execute semantic queries with mode selection (local/global/hybrid/naive/mix) |

### Document Management

| Tool | Description |
|------|-------------|
| `insert_document` | Insert text content directly |
| `insert_file` | Insert from file path |
| `insert_batch` | Batch insert from directory |
| `upload_document` | Upload to input directory |
| `scan_for_new_documents` | Scan and queue new documents |
| `get_documents` | List all documents |
| `get_pipeline_status` | Check processing pipeline |

### Knowledge Graph

| Tool | Description |
|------|-------------|
| `get_graph_labels` | Get entity and relationship types |
| `create_entities` | Create new entities |
| `edit_entities` | Update existing entities |
| `delete_by_entities` | Delete by entity name |
| `delete_by_doc_ids` | Delete by document ID |
| `create_relations` | Create relationships |
| `edit_relations` | Update relationships |
| `merge_entities` | Merge multiple entities |

### Monitoring

| Tool | Description |
|------|-------------|
| `check_lightrag_health` | System health check |

## Configuration

All configuration is via environment variables with `LIGHTRAG_` prefix.

### Required

| Variable | Description |
|----------|-------------|
| `LIGHTRAG_LLM_API_KEY` | API key for LLM provider |

### LLM Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `LIGHTRAG_LLM_PROVIDER` | openai | Provider: `openai`, `anthropic`, `gemini` |
| `LIGHTRAG_LLM_MODEL` | gpt-4o-mini | Model name |
| `LIGHTRAG_LLM_BASE_URL` | - | Custom base URL (for proxies) |

### Embedding Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `LIGHTRAG_EMBEDDING_PROVIDER` | openai | Provider: `openai`, `gemini` |
| `LIGHTRAG_EMBEDDING_MODEL` | text-embedding-3-large | Embedding model |
| `LIGHTRAG_EMBEDDING_API_KEY` | - | API key (defaults to LLM_API_KEY) |

> **Note**: Anthropic doesn't offer embeddings. Use OpenAI or Gemini for embeddings even with Anthropic LLM.

### Storage (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `LIGHTRAG_NEO4J_URI` | - | Neo4j connection (falls back to NetworkXStorage) |
| `LIGHTRAG_NEO4J_PASSWORD` | - | Neo4j password |
| `LIGHTRAG_QDRANT_URL` | - | Qdrant connection (falls back to NanoVectorDBStorage) |

See `.env.example` for complete configuration options.

## Usage Examples

### With OpenAI (Default)

```bash
docker run -d -p 8080:8080 \
  -e LIGHTRAG_LLM_API_KEY=sk-xxx \
  -v lightrag-data:/app/data \
  archestra/light-rag-mcp:latest
```

### With Anthropic LLM + OpenAI Embeddings

```bash
docker run -d -p 8080:8080 \
  -e LIGHTRAG_LLM_PROVIDER=anthropic \
  -e LIGHTRAG_LLM_MODEL=claude-sonnet-4-20250514 \
  -e LIGHTRAG_LLM_API_KEY=sk-ant-xxx \
  -e LIGHTRAG_EMBEDDING_PROVIDER=openai \
  -e LIGHTRAG_EMBEDDING_API_KEY=sk-xxx \
  -v lightrag-data:/app/data \
  archestra/light-rag-mcp:latest
```

### With Google Gemini

```bash
docker run -d -p 8080:8080 \
  -e LIGHTRAG_LLM_PROVIDER=gemini \
  -e LIGHTRAG_LLM_MODEL=gemini-2.0-flash \
  -e LIGHTRAG_LLM_API_KEY=xxx \
  -e LIGHTRAG_EMBEDDING_PROVIDER=gemini \
  -e LIGHTRAG_EMBEDDING_MODEL=text-embedding-004 \
  -v lightrag-data:/app/data \
  archestra/light-rag-mcp:latest
```

### With External Neo4j + Qdrant

```bash
docker run -d -p 8080:8080 \
  -e LIGHTRAG_NEO4J_URI=neo4j://neo4j:7687 \
  -e LIGHTRAG_NEO4J_PASSWORD=password \
  -e LIGHTRAG_QDRANT_URL=http://qdrant:6333 \
  -e LIGHTRAG_LLM_API_KEY=sk-xxx \
  archestra/light-rag-mcp:latest
```

## Archestra Integration

Install as a local MCP server in Archestra:

1. Go to **MCP Catalog** in Archestra
2. Add a new **Local Server**
3. Configure:
   - **Docker Image**: `archestra/light-rag-mcp:latest`
   - **Port**: `8080`
   - **Path**: `/mcp`
4. Set environment variables for your LLM provider and storage

## Development

```bash
# Install dependencies
pip install -e ".[dev]"

# Run locally
python -m light_rag_mcp.server

# Run tests
pytest

# Lint
ruff check src/
```

## Building Docker Image

```bash
# Build
docker build -t light-rag-mcp:latest .

# Push to Docker Hub
docker tag light-rag-mcp:latest archestra/light-rag-mcp:latest
docker push archestra/light-rag-mcp:latest
```

## License

MIT
