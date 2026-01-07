"""Factory functions for creating LLM and embedding providers."""

from ..config import Settings, LLMProvider as LLMProviderEnum, EmbeddingProvider as EmbeddingProviderEnum
from .base import LLMProvider, EmbeddingProvider
from .openai_provider import OpenAILLMProvider, OpenAIEmbeddingProvider
from .anthropic_provider import AnthropicLLMProvider
from .gemini_provider import GeminiLLMProvider, GeminiEmbeddingProvider


def create_llm_provider(settings: Settings) -> LLMProvider:
    """Create an LLM provider based on configuration.

    Args:
        settings: Application settings.

    Returns:
        Configured LLM provider instance.

    Raises:
        ValueError: If required API key is not provided.
    """
    if not settings.llm_api_key:
        raise ValueError(
            f"LLM API key is required for provider '{settings.llm_provider.value}'. "
            "Set LIGHTRAG_LLM_API_KEY environment variable."
        )

    if settings.llm_provider == LLMProviderEnum.OPENAI:
        return OpenAILLMProvider(
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            base_url=settings.llm_base_url,
            max_tokens=settings.llm_max_tokens,
        )
    elif settings.llm_provider == LLMProviderEnum.ANTHROPIC:
        return AnthropicLLMProvider(
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            base_url=settings.llm_base_url,
            max_tokens=settings.llm_max_tokens,
        )
    elif settings.llm_provider == LLMProviderEnum.GEMINI:
        return GeminiLLMProvider(
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            max_tokens=settings.llm_max_tokens,
        )
    else:
        raise ValueError(f"Unsupported LLM provider: {settings.llm_provider}")


def create_embedding_provider(settings: Settings) -> EmbeddingProvider:
    """Create an embedding provider based on configuration.

    Args:
        settings: Application settings.

    Returns:
        Configured embedding provider instance.

    Raises:
        ValueError: If required API key is not provided.
    """
    api_key = settings.effective_embedding_api_key
    if not api_key:
        raise ValueError(
            f"Embedding API key is required for provider '{settings.embedding_provider.value}'. "
            "Set LIGHTRAG_EMBEDDING_API_KEY or LIGHTRAG_LLM_API_KEY environment variable."
        )

    if settings.embedding_provider == EmbeddingProviderEnum.OPENAI:
        return OpenAIEmbeddingProvider(
            api_key=api_key,
            model=settings.embedding_model,
            base_url=settings.llm_base_url,  # Use same base URL for consistency
        )
    elif settings.embedding_provider == EmbeddingProviderEnum.GEMINI:
        return GeminiEmbeddingProvider(
            api_key=api_key,
            model=settings.embedding_model,
        )
    else:
        raise ValueError(f"Unsupported embedding provider: {settings.embedding_provider}")
