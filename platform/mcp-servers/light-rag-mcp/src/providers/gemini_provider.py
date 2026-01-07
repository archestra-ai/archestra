"""Google Gemini provider for LLM and embeddings."""

from typing import Optional

import numpy as np
from google import genai
from google.genai import types
from lightrag.utils import EmbeddingFunc

from .base import EmbeddingProvider, LLMProvider, LLMFunc


class GeminiLLMProvider(LLMProvider):
    """Google Gemini LLM provider."""

    def __init__(
        self,
        api_key: str,
        model: str = "gemini-2.0-flash",
        max_tokens: int = 9000,
    ):
        """Initialize Gemini LLM provider.

        Args:
            api_key: Google AI API key.
            model: Gemini model name to use.
            max_tokens: Maximum tokens for responses.
        """
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens

    def get_llm_func(self) -> LLMFunc:
        """Get a LightRAG-compatible LLM function.

        Returns a standalone function that doesn't hold unpicklable references.
        """
        # Capture values in closure (not self)
        model = self.model
        api_key = self.api_key
        max_tokens = self.max_tokens

        async def llm_func(
            prompt: str,
            system_prompt: Optional[str] = None,
            history_messages: list = [],
            keyword_extraction: bool = False,
            **kwargs,
        ) -> str:
            # Create client inside the function to avoid pickling issues
            client = genai.Client(api_key=api_key)

            # Build content with system prompt if provided
            content = prompt
            if system_prompt:
                content = f"{system_prompt}\n\n{prompt}"

            response = await client.aio.models.generate_content(
                model=model,
                contents=content,
                config=types.GenerateContentConfig(
                    max_output_tokens=kwargs.get("max_tokens", max_tokens),
                    temperature=kwargs.get("temperature", 0.7),
                ),
            )
            return response.text or ""

        return llm_func

    async def complete(self, prompt: str, **kwargs) -> str:
        """Generate a completion for health checks."""
        client = genai.Client(api_key=self.api_key)

        response = await client.aio.models.generate_content(
            model=self.model,
            contents=prompt,
            config=types.GenerateContentConfig(
                max_output_tokens=kwargs.get("max_tokens", 100),
            ),
        )
        return response.text or ""


class GeminiEmbeddingProvider(EmbeddingProvider):
    """Google Gemini embedding provider."""

    # Model-specific embedding dimensions
    MODEL_DIMS = {
        "text-embedding-004": 768,
        "embedding-001": 768,
    }

    def __init__(
        self,
        api_key: str,
        model: str = "text-embedding-004",
        embedding_dim: Optional[int] = None,
    ):
        """Initialize Gemini embedding provider.

        Args:
            api_key: Google AI API key.
            model: Embedding model name.
            embedding_dim: Override embedding dimensions.
        """
        self.api_key = api_key
        self.model = model
        self.embedding_dim = embedding_dim or self.MODEL_DIMS.get(model, 768)
        self.max_token_size = 8192

    def get_embedding_func(self) -> EmbeddingFunc:
        """Get a LightRAG-compatible embedding function.

        Returns EmbeddingFunc wrapper with proper attributes.
        """
        # Capture values in closure (not self)
        model = self.model
        api_key = self.api_key
        embedding_dim = self.embedding_dim
        max_token_size = self.max_token_size

        async def embed_func(texts: list[str]) -> np.ndarray:
            if not texts:
                return np.array([])

            # Create client inside the function to avoid pickling issues
            client = genai.Client(api_key=api_key)

            embeddings = []
            for text in texts:
                response = await client.aio.models.embed_content(
                    model=model,
                    content=text,
                )
                embeddings.append(response.embedding)

            return np.array(embeddings)

        # Use LightRAG's EmbeddingFunc wrapper
        return EmbeddingFunc(
            embedding_dim=embedding_dim,
            max_token_size=max_token_size,
            func=embed_func,
        )

    async def embed(self, texts: list[str]) -> np.ndarray:
        """Generate embeddings for health checks."""
        if not texts:
            return np.array([])

        client = genai.Client(api_key=self.api_key)

        embeddings = []
        for text in texts:
            response = await client.aio.models.embed_content(
                model=self.model,
                content=text,
            )
            embeddings.append(response.embedding)

        return np.array(embeddings)
