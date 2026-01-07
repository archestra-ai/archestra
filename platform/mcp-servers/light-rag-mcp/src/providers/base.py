"""Base provider interfaces for LLM and embedding providers."""

from abc import ABC, abstractmethod
from typing import Callable, Coroutine, Any

import numpy as np


# Type aliases for LightRAG-compatible functions
LLMFunc = Callable[..., Coroutine[Any, Any, str]]
EmbeddingFunc = Callable[[list[str]], Coroutine[Any, Any, np.ndarray]]


class LLMProvider(ABC):
    """Abstract base class for LLM providers."""

    @abstractmethod
    def get_llm_func(self) -> LLMFunc:
        """Get a LightRAG-compatible LLM function.

        Returns:
            A standalone async function (not a bound method) for LLM completion.
        """
        pass

    @abstractmethod
    async def complete(self, prompt: str, **kwargs) -> str:
        """Generate a completion for the given prompt (for health checks).

        Args:
            prompt: The input prompt to complete.
            **kwargs: Additional provider-specific arguments.

        Returns:
            The generated completion text.
        """
        pass


class EmbeddingProvider(ABC):
    """Abstract base class for embedding providers."""

    # Subclasses should set these
    embedding_dim: int = 3072
    max_token_size: int = 8192

    @abstractmethod
    def get_embedding_func(self) -> EmbeddingFunc:
        """Get a LightRAG-compatible embedding function.

        Returns:
            A standalone async function (not a bound method) for embeddings.
        """
        pass

    @abstractmethod
    async def embed(self, texts: list[str]) -> np.ndarray:
        """Generate embeddings for the given texts (for health checks).

        Args:
            texts: List of texts to embed.

        Returns:
            numpy array of embedding vectors.
        """
        pass
