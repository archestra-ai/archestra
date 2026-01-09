/**
 * x.ai (Grok) Adapter Factory
 *
 * x.ai uses an OpenAI-compatible API at https://api.x.ai/v1
 * This adapter wraps the OpenAI adapter with x.ai configuration.
 */
import config from "@/config";
import logger from "@/logging";
import { openaiAdapterFactory } from "./openai";
import type { CreateClientOptions } from "@/types";

/**
 * Creates x.ai adapters by delegating to the OpenAI adapter factory
 * with x.ai-specific base URL configuration.
 */
export const xaiAdapterFactory: typeof openaiAdapterFactory = (
    request,
    options,
) => {
    const xaiOptions: CreateClientOptions = {
        ...options,
        baseUrl: options?.baseUrl || config.llm.xai.baseUrl,
    };

    logger.debug(
        { baseUrl: xaiOptions.baseUrl },
        "[XaiAdapter] Creating x.ai adapter with OpenAI-compatible API",
    );

    return openaiAdapterFactory(request, xaiOptions);
};
