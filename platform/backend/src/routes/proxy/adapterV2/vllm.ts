/**
 * vLLM Adapter Factory
 *
 * vLLM uses an OpenAI-compatible API at a configurable base URL
 * This adapter wraps the OpenAI adapter with vLLM configuration.
 */
import config from "@/config";
import logger from "@/logging";
import { openaiAdapterFactory } from "./openai";
import type { CreateClientOptions } from "@/types";

/**
 * Creates vLLM adapters by delegating to the OpenAI adapter factory
 * with vLLM-specific base URL configuration.
 */
export const vllmAdapterFactory: typeof openaiAdapterFactory = (
    request,
    options,
) => {
    const vllmOptions: CreateClientOptions = {
        ...options,
        baseUrl: options?.baseUrl || config.llm.vllm.baseUrl,
    };

    logger.debug(
        { baseUrl: vllmOptions.baseUrl },
        "[VllmAdapter] Creating vLLM adapter with OpenAI-compatible API",
    );

    return openaiAdapterFactory(request, vllmOptions);
};
