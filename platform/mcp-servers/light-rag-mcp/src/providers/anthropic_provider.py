"""Anthropic provider for LLM (Claude models)."""

from typing import Optional

import anthropic

from .base import LLMProvider, LLMFunc


class AnthropicLLMProvider(LLMProvider):
    """Anthropic LLM provider for Claude models."""

    def __init__(
        self,
        api_key: str,
        model: str = "claude-sonnet-4-20250514",
        base_url: Optional[str] = None,
        max_tokens: int = 9000,
    ):
        """Initialize Anthropic LLM provider.

        Args:
            api_key: Anthropic API key.
            model: Claude model name to use.
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
            # Create client inside the function to avoid pickling issues
            client = anthropic.AsyncAnthropic(
                api_key=api_key,
                base_url=base_url,
            )

            messages = []

            # Add history messages if provided
            for msg in history_messages:
                role = msg.get("role", "user")
                content = msg.get("content", "")
                if role in ("user", "assistant"):
                    messages.append({"role": role, "content": content})

            # Add current prompt
            messages.append({"role": "user", "content": prompt})

            response = await client.messages.create(
                model=model,
                max_tokens=kwargs.get("max_tokens", max_tokens),
                system=system_prompt or "",
                messages=messages,
            )

            return response.content[0].text

        return llm_func

    async def complete(self, prompt: str, **kwargs) -> str:
        """Generate a completion for health checks."""
        client = anthropic.AsyncAnthropic(
            api_key=self.api_key,
            base_url=self.base_url,
        )

        response = await client.messages.create(
            model=self.model,
            max_tokens=kwargs.get("max_tokens", 100),
            messages=[{"role": "user", "content": prompt}],
        )

        return response.content[0].text
