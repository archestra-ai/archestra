"""OpenAI provider using LightRAG's built-in functions."""

from typing import Optional

import numpy as np
from lightrag.llm.openai import openai_complete_if_cache, openai_embed
from lightrag.utils import EmbeddingFunc

from .base import EmbeddingProvider, LLMProvider, LLMFunc

# Get the raw embedding function (not the EmbeddingFunc wrapper)
_raw_openai_embed = openai_embed.func


class OpenAILLMProvider(LLMProvider):
    """OpenAI LLM provider using LightRAG's built-in functions."""

    def __init__(
        self,
        api_key: str,
        model: str = "gpt-4o-mini",
        base_url: Optional[str] = None,
        max_tokens: int = 9000,
    ):
        """Initialize OpenAI LLM provider.

        Args:
            api_key: OpenAI API key.
            model: Model name to use.
            base_url: Optional custom base URL.
            max_tokens: Maximum tokens for responses.
        """
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self.max_tokens = max_tokens

    def get_llm_func(self) -> LLMFunc:
        """Get a LightRAG-compatible LLM function.

        Returns a standalone function that doesn't hold unpicklable references.
        """
        # Capture values in closure (not self)
        model = self.model
        api_key = self.api_key
        base_url = self.base_url
        max_tokens = self.max_tokens

        async def llm_func(
            prompt: str,
            system_prompt: Optional[str] = None,
            history_messages: list = [],
            keyword_extraction: bool = False,
            **kwargs,
        ) -> str:
            return await openai_complete_if_cache(
                model,
                prompt,
                system_prompt=system_prompt,
                history_messages=history_messages,
                api_key=api_key,
                base_url=base_url,
                max_tokens=kwargs.get("max_tokens", max_tokens),
                **kwargs,
            )

        return llm_func

    async def complete(self, prompt: str, **kwargs) -> str:
        """Generate a completion for health checks."""
        return await openai_complete_if_cache(
            self.model,
            prompt,
            api_key=self.api_key,
            base_url=self.base_url,
            max_tokens=kwargs.get("max_tokens", 100),
            **kwargs,
        )


class OpenAIEmbeddingProvider(EmbeddingProvider):
    """OpenAI embedding provider using LightRAG's built-in functions."""

    # Model-specific embedding dimensions
    MODEL_DIMS = {
        "text-embedding-3-large": 3072,
        "text-embedding-3-small": 1536,
        "text-embedding-ada-002": 1536,
    }

    def __init__(
        self,
        api_key: str,
        model: str = "text-embedding-3-large",
        base_url: Optional[str] = None,
        embedding_dim: Optional[int] = None,
    ):
        """Initialize OpenAI embedding provider.

        Args:
            api_key: OpenAI API key.
            model: Embedding model name.
            base_url: Optional custom base URL.
            embedding_dim: Override embedding dimensions.
        """
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self.embedding_dim = embedding_dim or self.MODEL_DIMS.get(model, 3072)
        self.max_token_size = 8192

    def get_embedding_func(self) -> EmbeddingFunc:
        """Get a LightRAG-compatible embedding function.

        Returns EmbeddingFunc wrapper with proper attributes.
        """
        # Capture values in closure (not self)
        model = self.model
        api_key = self.api_key
        base_url = self.base_url
        embedding_dim = self.embedding_dim
        max_token_size = self.max_token_size

        async def embed_func(texts: list[str]) -> np.ndarray:
            # Use the raw function directly to avoid double-wrapping
            return await _raw_openai_embed(
                texts,
                model=model,
                api_key=api_key,
                base_url=base_url,
                max_token_size=max_token_size,
            )

        # Use LightRAG's EmbeddingFunc wrapper
        return EmbeddingFunc(
            embedding_dim=embedding_dim,
            max_token_size=max_token_size,
            func=embed_func,
        )

    async def embed(self, texts: list[str]) -> np.ndarray:
        """Generate embeddings for health checks."""
        return await _raw_openai_embed(
            texts,
            model=self.model,
            api_key=self.api_key,
            base_url=self.base_url,
            max_token_size=self.max_token_size,
        )
