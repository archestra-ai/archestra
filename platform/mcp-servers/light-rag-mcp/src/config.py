"""Configuration management via environment variables."""

from enum import Enum
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class LLMProvider(str, Enum):
    """Supported LLM providers."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"


class EmbeddingProvider(str, Enum):
    """Supported embedding providers."""

    OPENAI = "openai"
    GEMINI = "gemini"


class Settings(BaseSettings):
    """LightRAG MCP Server Settings."""

    model_config = SettingsConfigDict(
        env_prefix="LIGHTRAG_",
        env_file=".env",
        case_sensitive=False,
        extra="ignore",
    )

    # Server configuration
    host: str = Field(default="0.0.0.0", description="Server bind address")
    port: int = Field(default=8080, description="Server port")
    mcp_path: str = Field(default="/mcp", description="MCP endpoint path")
    working_dir: str = Field(default="/app/data", description="Data directory for LightRAG")
    workspace: str = Field(default="default", description="LightRAG workspace name")

    # Neo4j configuration (optional - falls back to NetworkXStorage)
    neo4j_uri: Optional[str] = Field(default=None, description="Neo4j connection URI")
    neo4j_username: str = Field(default="neo4j", description="Neo4j username")
    neo4j_password: Optional[str] = Field(default=None, description="Neo4j password")
    neo4j_database: str = Field(default="neo4j", description="Neo4j database name")

    # Qdrant configuration (optional - falls back to NanoVectorDBStorage)
    qdrant_url: Optional[str] = Field(default=None, description="Qdrant connection URL")
    qdrant_api_key: Optional[str] = Field(default=None, description="Qdrant API key")
    qdrant_collection_prefix: str = Field(
        default="lightrag", description="Prefix for Qdrant collections"
    )

    # LLM configuration
    llm_provider: LLMProvider = Field(
        default=LLMProvider.OPENAI, description="LLM provider to use"
    )
    llm_model: str = Field(default="gpt-4o-mini", description="LLM model name")
    llm_api_key: Optional[str] = Field(default=None, description="API key for LLM provider")
    llm_base_url: Optional[str] = Field(
        default=None, description="Custom base URL for LLM API (for proxies)"
    )
    llm_max_tokens: int = Field(default=9000, description="Maximum tokens for LLM responses")

    # Embedding configuration
    embedding_provider: EmbeddingProvider = Field(
        default=EmbeddingProvider.OPENAI, description="Embedding provider to use"
    )
    embedding_model: str = Field(
        default="text-embedding-3-large", description="Embedding model name"
    )
    embedding_api_key: Optional[str] = Field(
        default=None, description="API key for embedding provider (defaults to llm_api_key)"
    )
    embedding_dim: int = Field(default=3072, description="Embedding vector dimensions")

    # Document processing
    chunk_token_size: int = Field(default=1200, description="Token size for document chunks")
    chunk_overlap_token_size: int = Field(
        default=100, description="Overlap tokens between chunks"
    )
    max_parallel_insert: int = Field(
        default=2, description="Maximum parallel document insertions"
    )

    @field_validator("llm_api_key", mode="before")
    @classmethod
    def validate_llm_api_key(cls, v: Optional[str]) -> Optional[str]:
        """Ensure LLM API key is provided."""
        if v is None or v.strip() == "":
            return None
        return v.strip()

    @property
    def effective_embedding_api_key(self) -> Optional[str]:
        """Get the effective embedding API key, falling back to LLM API key."""
        return self.embedding_api_key or self.llm_api_key

    @property
    def use_neo4j(self) -> bool:
        """Check if Neo4j should be used."""
        return self.neo4j_uri is not None and self.neo4j_password is not None

    @property
    def use_qdrant(self) -> bool:
        """Check if Qdrant should be used."""
        return self.qdrant_url is not None

    @property
    def graph_storage_type(self) -> str:
        """Get the graph storage type based on configuration."""
        return "Neo4JStorage" if self.use_neo4j else "NetworkXStorage"

    @property
    def vector_storage_type(self) -> str:
        """Get the vector storage type based on configuration."""
        return "QdrantVectorDBStorage" if self.use_qdrant else "NanoVectorDBStorage"


# Global settings instance
settings = Settings()
