"""LightRAG lifecycle management with Neo4j and Qdrant."""

import os
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from lightrag import LightRAG

from .config import Settings, settings
from .providers import create_llm_provider, create_embedding_provider
from .providers.base import LLMProvider, EmbeddingProvider


logger = logging.getLogger(__name__)


@dataclass
class LightRAGContext:
    """Application context holding initialized LightRAG instance."""

    rag: LightRAG
    llm_provider: LLMProvider
    embedding_provider: EmbeddingProvider
    settings: Settings = field(default_factory=lambda: settings)
    is_healthy: bool = True


def _setup_environment(settings: Settings) -> None:
    """Set up environment variables for LightRAG storage backends.

    Args:
        settings: Application settings.
    """
    # Ensure working directory exists
    Path(settings.working_dir).mkdir(parents=True, exist_ok=True)

    # Set Neo4j environment variables if configured
    if settings.use_neo4j:
        os.environ["NEO4J_URI"] = settings.neo4j_uri  # type: ignore
        os.environ["NEO4J_USERNAME"] = settings.neo4j_username
        os.environ["NEO4J_PASSWORD"] = settings.neo4j_password  # type: ignore
        os.environ["NEO4J_DATABASE"] = settings.neo4j_database
        logger.info(f"Neo4j configured: {settings.neo4j_uri}")
    else:
        logger.info("Neo4j not configured, using NetworkXStorage (local files)")

    # Set Qdrant environment variables if configured
    if settings.use_qdrant:
        os.environ["QDRANT_URL"] = settings.qdrant_url  # type: ignore
        if settings.qdrant_api_key:
            os.environ["QDRANT_API_KEY"] = settings.qdrant_api_key
        logger.info(f"Qdrant configured: {settings.qdrant_url}")
    else:
        logger.info("Qdrant not configured, using NanoVectorDBStorage (local files)")


async def create_lightrag_instance(
    app_settings: Optional[Settings] = None,
) -> LightRAGContext:
    """Create and initialize LightRAG with configured storage backends.

    Args:
        app_settings: Optional settings override. Uses global settings if not provided.

    Returns:
        Initialized LightRAGContext with the RAG instance and providers.

    Raises:
        ValueError: If required configuration is missing.
    """
    s = app_settings or settings

    # Set up environment for storage backends
    _setup_environment(s)

    # Create LLM and embedding providers
    llm_provider = create_llm_provider(s)
    embedding_provider = create_embedding_provider(s)

    logger.info(f"LLM provider: {s.llm_provider.value} ({s.llm_model})")
    logger.info(f"Embedding provider: {s.embedding_provider.value} ({s.embedding_model})")

    # Create LightRAG instance with configured storage backends
    # Note: embedding_dim is now attached to the embedding_func via wrap_embedding_func_with_attrs
    rag = LightRAG(
        working_dir=s.working_dir,
        llm_model_func=llm_provider.get_llm_func(),
        embedding_func=embedding_provider.get_embedding_func(),
        graph_storage=s.graph_storage_type,
        vector_storage=s.vector_storage_type,
        chunk_token_size=s.chunk_token_size,
        chunk_overlap_token_size=s.chunk_overlap_token_size,
    )

    # Initialize storages (required for document operations)
    await rag.initialize_storages()

    logger.info(f"LightRAG initialized with graph_storage={s.graph_storage_type}, "
                f"vector_storage={s.vector_storage_type}")

    return LightRAGContext(
        rag=rag,
        llm_provider=llm_provider,
        embedding_provider=embedding_provider,
        settings=s,
        is_healthy=True,
    )


async def shutdown_lightrag(context: LightRAGContext) -> None:
    """Gracefully shutdown LightRAG and close connections.

    Args:
        context: The LightRAG context to shutdown.
    """
    logger.info("Shutting down LightRAG...")

    try:
        # Finalize storages if available
        if hasattr(context.rag, "finalize_storages"):
            await context.rag.finalize_storages()
        context.is_healthy = False
        logger.info("LightRAG shutdown complete")
    except Exception as e:
        logger.error(f"Error during LightRAG shutdown: {e}")
        raise
