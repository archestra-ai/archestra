/**
 * Ollama Adapter Factory
 *
 * Wraps the OpenAI adapter factory for Ollama's OpenAI-compatible API.
 * Default base URL: http://localhost:11434/v1
 */
import config from "@/config";
import logger from "@/logging";
import { openaiAdapterFactory } from "./openai";

interface OllamaClientOptions {
    baseUrl?: string;
    apiKey?: string;
}

/**
 * Creates an Ollama adapter by wrapping the OpenAI adapter
 * with Ollama-specific configuration.
 */
export const ollamaAdapterFactory: typeof openaiAdapterFactory = (
    request,
    options,
) => {
    const ollamaOptions: OllamaClientOptions = {
        ...options,
        baseUrl: options?.baseUrl || config.llm.ollama.baseUrl,
    };

    logger.debug(
        { baseUrl: ollamaOptions.baseUrl },
        "[OllamaAdapter] Creating Ollama adapter with OpenAI-compatible API",
    );

    return openaiAdapterFactory(request, ollamaOptions);
};
