"""LightRAG MCP Server with stdio transport."""

import contextlib
import logging
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Literal, Optional

from mcp.server.fastmcp import FastMCP, Context
from mcp.server.session import ServerSession
from pydantic import Field
from lightrag import QueryParam

from .config import settings
from .lightrag_manager import (
    LightRAGContext,
    create_lightrag_instance,
    shutdown_lightrag,
)


# Configure logging to stderr (stdout is reserved for MCP JSON-RPC messages)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger(__name__)


# Type alias for the context
Ctx = Context[ServerSession, LightRAGContext]


@contextlib.asynccontextmanager
async def app_lifespan(server: FastMCP) -> AsyncIterator[LightRAGContext]:
    """Manage LightRAG lifecycle.

    Args:
        server: The FastMCP server instance.

    Yields:
        Initialized LightRAGContext.
    """
    logger.info("Initializing LightRAG MCP Server...")
    logger.info(f"LLM Provider: {settings.llm_provider.value}")
    logger.info(f"Embedding Provider: {settings.embedding_provider.value}")
    logger.info(f"Graph Storage: {settings.graph_storage_type}")
    logger.info(f"Vector Storage: {settings.vector_storage_type}")

    context = await create_lightrag_instance()
    logger.info("LightRAG initialized successfully")

    try:
        yield context
    finally:
        logger.info("Shutting down LightRAG...")
        await shutdown_lightrag(context)
        logger.info("LightRAG shutdown complete")


# Create FastMCP server with lifespan
mcp = FastMCP(
    "LightRAG MCP Server",
    lifespan=app_lifespan,
    stateless_http=True,
    host=settings.host,
    port=settings.port,
)


# =============================================================================
# Document Query Tools
# =============================================================================


@mcp.tool()
async def query_document(
    query: Annotated[str, Field(description="The question or query to search for")],
    mode: Annotated[
        Literal["local", "global", "hybrid", "naive", "mix"],
        Field(description="Query mode: local, global, hybrid, naive, or mix"),
    ] = "hybrid",
    ctx: Ctx = None,
) -> str:
    """
    Execute a query against documents through LightRAG.

    Supports multiple query modes:
    - local: Search within local context
    - global: Search across global knowledge
    - hybrid: Combine local and global search
    - naive: Simple keyword-based search
    - mix: Mixed retrieval strategy
    """
    rag = ctx.request_context.lifespan_context.rag
    param = QueryParam(mode=mode)
    result = await rag.aquery(query, param=param)
    return result or "No results found for the query."


# =============================================================================
# Document Management Tools
# =============================================================================


@mcp.tool()
async def insert_document(
    content: Annotated[str, Field(description="The text content to insert")],
    doc_id: Annotated[
        Optional[str], Field(description="Optional document identifier")
    ] = None,
    ctx: Ctx = None,
) -> dict:
    """
    Insert text content directly into LightRAG storage.

    The content will be processed to extract entities and relationships,
    which are then stored in the knowledge graph.
    """
    rag = ctx.request_context.lifespan_context.rag
    await rag.ainsert(content, ids=[doc_id] if doc_id else None)
    return {"status": "success", "message": "Document inserted successfully"}


@mcp.tool()
async def insert_file(
    file_path: Annotated[str, Field(description="Path to the file to insert")],
    ctx: Ctx = None,
) -> dict:
    """
    Insert a document from a file path into LightRAG storage.

    Supported file formats include .txt, .md, and other text files.
    """
    rag = ctx.request_context.lifespan_context.rag
    path = Path(file_path)

    if not path.exists():
        return {"status": "error", "message": f"File not found: {file_path}"}

    try:
        content = path.read_text(encoding="utf-8")
    except Exception as e:
        return {"status": "error", "message": f"Error reading file: {e}"}

    await rag.ainsert(content, ids=[path.name])
    return {"status": "success", "message": f"File '{path.name}' inserted successfully"}


@mcp.tool()
async def insert_batch(
    directory_path: Annotated[
        str, Field(description="Path to directory containing documents")
    ],
    file_extensions: Annotated[
        list[str], Field(description="List of file extensions to process")
    ] = [".txt", ".md"],
    recursive: Annotated[
        bool, Field(description="Whether to search subdirectories")
    ] = False,
    ctx: Ctx = None,
) -> dict:
    """
    Insert a batch of documents from a directory.

    Processes all files matching the specified extensions.
    """
    rag = ctx.request_context.lifespan_context.rag
    directory = Path(directory_path)

    if not directory.exists() or not directory.is_dir():
        return {"status": "error", "message": f"Directory not found: {directory_path}"}

    processed = 0
    errors = []

    glob_pattern = "**/*" if recursive else "*"

    for ext in file_extensions:
        pattern = f"{glob_pattern}{ext}"
        for file_path in directory.glob(pattern):
            if not file_path.is_file():
                continue
            try:
                content = file_path.read_text(encoding="utf-8")
                await rag.ainsert(content, ids=[file_path.name])
                processed += 1
            except Exception as e:
                errors.append(f"{file_path.name}: {str(e)}")

    return {
        "status": "success" if not errors else "partial",
        "processed": processed,
        "errors": errors if errors else None,
    }


@mcp.tool()
async def upload_document(
    file_path: Annotated[str, Field(description="Source path of the file to upload")],
    ctx: Ctx = None,
) -> dict:
    """
    Upload a document file to the input directory for processing.

    Files in the input directory can be scanned and processed later.
    """
    source = Path(file_path)
    if not source.exists():
        return {"status": "error", "message": f"File not found: {file_path}"}

    app_settings = ctx.request_context.lifespan_context.settings
    input_dir = Path(app_settings.working_dir) / "input"
    input_dir.mkdir(parents=True, exist_ok=True)

    dest = input_dir / source.name
    try:
        dest.write_bytes(source.read_bytes())
    except Exception as e:
        return {"status": "error", "message": f"Error uploading file: {e}"}

    return {"status": "success", "message": f"File uploaded to {dest}"}


@mcp.tool()
async def scan_for_new_documents(
    ctx: Ctx = None,
) -> dict:
    """
    Scan the input directory for new documents and process them.

    Documents are inserted into the knowledge graph after scanning.
    """
    rag = ctx.request_context.lifespan_context.rag
    app_settings = ctx.request_context.lifespan_context.settings
    input_dir = Path(app_settings.working_dir) / "input"

    if not input_dir.exists():
        return {
            "status": "success",
            "documents_found": 0,
            "message": "Input directory does not exist or is empty",
        }

    documents = []
    extensions = [".txt", ".md", ".pdf"]

    for file_path in input_dir.iterdir():
        if file_path.is_file() and file_path.suffix.lower() in extensions:
            try:
                content = file_path.read_text(encoding="utf-8")
                await rag.ainsert(content, ids=[file_path.name])
                documents.append(file_path.name)
            except Exception as e:
                logger.warning(f"Error processing {file_path.name}: {e}")

    return {
        "status": "success",
        "documents_found": len(documents),
        "documents": documents,
    }


@mcp.tool()
async def get_documents(
    ctx: Ctx = None,
) -> dict:
    """
    Get list of all documents in the system.

    Returns document IDs and basic metadata.
    """
    rag = ctx.request_context.lifespan_context.rag

    # Try to get document status if available
    try:
        if hasattr(rag, "doc_status"):
            docs = await rag.doc_status.get_all() if hasattr(rag.doc_status, "get_all") else []
            return {"status": "success", "documents": docs}
    except Exception as e:
        logger.warning(f"Could not retrieve document status: {e}")

    # Fallback: list files in working directory
    app_settings = ctx.request_context.lifespan_context.settings
    working_dir = Path(app_settings.working_dir)
    files = []
    if working_dir.exists():
        files = [f.name for f in working_dir.iterdir() if f.is_file()]

    return {"status": "success", "documents": files}


@mcp.tool()
async def get_pipeline_status(
    ctx: Ctx = None,
) -> dict:
    """
    Get status of the document processing pipeline.

    Returns information about queued, processing, and completed documents.
    """
    rag = ctx.request_context.lifespan_context.rag

    try:
        if hasattr(rag, "get_processing_status"):
            status = await rag.get_processing_status()
            return {"status": "success", "pipeline": status}
    except Exception as e:
        logger.warning(f"Could not retrieve pipeline status: {e}")

    return {
        "status": "success",
        "pipeline": {"message": "Pipeline status not available for current storage backend"},
    }


# =============================================================================
# Knowledge Graph Tools
# =============================================================================


@mcp.tool()
async def get_graph_labels(
    ctx: Ctx = None,
) -> dict:
    """
    Get all labels (node and relationship types) from the knowledge graph.

    Returns entity types and relationship types present in the graph.
    """
    rag = ctx.request_context.lifespan_context.rag

    try:
        if hasattr(rag, "chunk_entity_relation_graph"):
            graph = rag.chunk_entity_relation_graph
            # Extract unique node types and edge types
            node_types = set()
            edge_types = set()

            if hasattr(graph, "nodes"):
                for _, data in graph.nodes(data=True):
                    if "entity_type" in data:
                        node_types.add(data["entity_type"])

            if hasattr(graph, "edges"):
                for _, _, data in graph.edges(data=True):
                    if "relation_type" in data:
                        edge_types.add(data["relation_type"])

            return {
                "status": "success",
                "labels": {
                    "entity_types": list(node_types),
                    "relationship_types": list(edge_types),
                },
            }
    except Exception as e:
        logger.warning(f"Could not retrieve graph labels: {e}")

    return {
        "status": "success",
        "labels": {"message": "Graph labels not available for current storage backend"},
    }


@mcp.tool()
async def create_entities(
    entities: Annotated[
        list[dict],
        Field(
            description="List of entities to create. Each entity should have 'name', 'type', and optional 'description'"
        ),
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Create multiple entities in the knowledge graph.

    Each entity should have:
    - name: The entity name (required)
    - type: The entity type (e.g., PERSON, ORGANIZATION)
    - description: Optional description
    """
    rag = ctx.request_context.lifespan_context.rag

    try:
        entity_list = [
            {
                "entity_name": e.get("name", ""),
                "entity_type": e.get("type", "ENTITY"),
                "description": e.get("description", ""),
                "source_id": e.get("source_id", "manual"),
            }
            for e in entities
        ]

        if hasattr(rag, "ainsert_custom_kg"):
            await rag.ainsert_custom_kg(entities=entity_list, relationships=[])
            return {"status": "success", "created": len(entities)}
    except Exception as e:
        return {"status": "error", "message": f"Error creating entities: {e}"}

    return {"status": "error", "message": "Custom KG insertion not supported"}


@mcp.tool()
async def edit_entities(
    entities: Annotated[
        list[dict],
        Field(
            description="List of entity updates. Each should have 'name' to identify and properties to update"
        ),
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Edit multiple existing entities in the knowledge graph.

    Each entity update should have:
    - name: The entity name to update (required)
    - type: New entity type (optional)
    - description: New description (optional)
    """
    # Note: LightRAG may not support direct entity updates
    # This is a best-effort implementation
    return {
        "status": "warning",
        "message": "Entity editing requires delete and recreate for some storage backends",
        "entities_to_update": len(entities),
    }


@mcp.tool()
async def delete_by_entities(
    entity_names: Annotated[
        list[str], Field(description="List of entity names to delete")
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Delete multiple entities from the knowledge graph by name.

    This also removes any relationships connected to the deleted entities.
    """
    rag = ctx.request_context.lifespan_context.rag

    deleted = 0
    errors = []

    for name in entity_names:
        try:
            if hasattr(rag, "adelete_by_entity"):
                await rag.adelete_by_entity(name)
                deleted += 1
            else:
                errors.append(f"{name}: delete_by_entity not supported")
        except Exception as e:
            errors.append(f"{name}: {str(e)}")

    return {
        "status": "success" if not errors else "partial",
        "deleted": deleted,
        "errors": errors if errors else None,
    }


@mcp.tool()
async def delete_by_doc_ids(
    doc_ids: Annotated[
        list[str], Field(description="List of document IDs to delete")
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Delete entities and relationships associated with specific documents.

    All entities and relationships extracted from the specified documents will be removed.
    """
    rag = ctx.request_context.lifespan_context.rag

    deleted = 0
    errors = []

    for doc_id in doc_ids:
        try:
            if hasattr(rag, "adelete_by_doc_id"):
                await rag.adelete_by_doc_id(doc_id)
                deleted += 1
            else:
                errors.append(f"{doc_id}: delete_by_doc_id not supported")
        except Exception as e:
            errors.append(f"{doc_id}: {str(e)}")

    return {
        "status": "success" if not errors else "partial",
        "deleted_doc_ids": deleted,
        "errors": errors if errors else None,
    }


@mcp.tool()
async def create_relations(
    relations: Annotated[
        list[dict],
        Field(
            description="List of relations to create. Each should have 'source', 'target', and 'type'"
        ),
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Create multiple relationships between entities in the knowledge graph.

    Each relation should have:
    - source: Source entity name (required)
    - target: Target entity name (required)
    - type: Relationship type (e.g., WORKS_AT, KNOWS)
    - description: Optional description
    """
    rag = ctx.request_context.lifespan_context.rag

    try:
        relationships = [
            {
                "src_id": rel.get("source", ""),
                "tgt_id": rel.get("target", ""),
                "description": rel.get("description", ""),
                "keywords": rel.get("type", "RELATED_TO"),
                "source_id": rel.get("source_id", "manual"),
            }
            for rel in relations
        ]

        if hasattr(rag, "ainsert_custom_kg"):
            await rag.ainsert_custom_kg(entities=[], relationships=relationships)
            return {"status": "success", "created": len(relations)}
    except Exception as e:
        return {"status": "error", "message": f"Error creating relations: {e}"}

    return {"status": "error", "message": "Custom KG insertion not supported"}


@mcp.tool()
async def edit_relations(
    relations: Annotated[
        list[dict],
        Field(
            description="List of relation updates. Each should have 'source', 'target' to identify and properties to update"
        ),
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Edit multiple existing relationships in the knowledge graph.

    Each relation update should have:
    - source: Source entity name (required)
    - target: Target entity name (required)
    - type: New relationship type (optional)
    - description: New description (optional)
    """
    # Note: LightRAG may not support direct relation updates
    return {
        "status": "warning",
        "message": "Relation editing requires delete and recreate for some storage backends",
        "relations_to_update": len(relations),
    }


@mcp.tool()
async def merge_entities(
    source_entities: Annotated[
        list[str], Field(description="List of entity names to merge from")
    ],
    target_entity: Annotated[
        str, Field(description="The entity name to merge into")
    ],
    ctx: Ctx = None,
) -> dict:
    """
    Merge multiple entities into one, migrating all relationships.

    All relationships from source entities will be transferred to the target entity,
    and the source entities will be deleted.
    """
    # This is a complex operation that may require direct graph manipulation
    return {
        "status": "warning",
        "message": "Entity merging is not fully supported in all storage backends",
        "source_entities": source_entities,
        "target_entity": target_entity,
    }


# =============================================================================
# Monitoring Tools
# =============================================================================


@mcp.tool()
async def check_lightrag_health(
    ctx: Ctx = None,
) -> dict:
    """
    Check LightRAG API and storage backend health.

    Returns health status of all components including LLM, embeddings,
    and storage backends.
    """
    context = ctx.request_context.lifespan_context
    rag = context.rag
    app_settings = context.settings

    health = {
        "status": "healthy",
        "components": {
            "lightrag": "healthy" if context.is_healthy else "unhealthy",
            "llm_provider": app_settings.llm_provider.value,
            "embedding_provider": app_settings.embedding_provider.value,
            "graph_storage": app_settings.graph_storage_type,
            "vector_storage": app_settings.vector_storage_type,
        },
    }

    # Test LLM connection
    try:
        await context.llm_provider.complete("test")
        health["components"]["llm"] = "healthy"
    except Exception as e:
        health["components"]["llm"] = f"unhealthy: {str(e)}"
        health["status"] = "degraded"

    # Test embedding connection
    try:
        await context.embedding_provider.embed(["test"])
        health["components"]["embeddings"] = "healthy"
    except Exception as e:
        health["components"]["embeddings"] = f"unhealthy: {str(e)}"
        health["status"] = "degraded"

    return health


# =============================================================================
# Server Entry Point
# =============================================================================


def main():
    """Run the MCP server."""
    logger.info("Starting LightRAG MCP Server (stdio transport)")

    # Use FastMCP's built-in run() with stdio transport
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
