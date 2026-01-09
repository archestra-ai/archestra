import config from "@/config";
import type {
    CreateClientOptions,
    LLMProvider,
    LLMRequestAdapter,
    LLMResponseAdapter,
    LLMStreamAdapter,
    OpenAi,
} from "@/types";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
    openaiAdapterFactory,
} from "./openai";

class XaiRequestAdapter extends OpenAIRequestAdapter {
    readonly provider = "xai" as const;
}

class XaiResponseAdapter extends OpenAIResponseAdapter {
    readonly provider = "xai" as const;
}

class XaiStreamAdapter extends OpenAIStreamAdapter {
    readonly provider = "xai" as const;
}

/**
 * Creates x.ai adapters by delegating to the OpenAI adapter factory
 * with x.ai-specific base URL configuration.
 */
export const xaiAdapterFactory: LLMProvider<
    OpenAi.Types.ChatCompletionsRequest,
    OpenAi.Types.ChatCompletionsResponse,
    OpenAi.Types.ChatCompletionsRequest["messages"],
    OpenAi.Types.ChatCompletionChunk,
    OpenAi.Types.ChatCompletionsHeaders
> = {
    ...openaiAdapterFactory,
    provider: "xai",
    interactionType: "xai:chatCompletions",

    createRequestAdapter(
        request: OpenAi.Types.ChatCompletionsRequest,
    ): LLMRequestAdapter<
        OpenAi.Types.ChatCompletionsRequest,
        OpenAi.Types.ChatCompletionsRequest["messages"]
    > {
        return new XaiRequestAdapter(request);
    },

    createResponseAdapter(
        response: OpenAi.Types.ChatCompletionsResponse,
    ): LLMResponseAdapter<OpenAi.Types.ChatCompletionsResponse> {
        return new XaiResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        OpenAi.Types.ChatCompletionChunk,
        OpenAi.Types.ChatCompletionsResponse
    > {
        return new XaiStreamAdapter();
    },

    getBaseUrl(): string | undefined {
        return config.llm.xai.baseUrl;
    },

    getSpanName(streaming: boolean): string {
        return `xai.chat.completions${streaming ? ".stream" : ""}`;
    },
};
