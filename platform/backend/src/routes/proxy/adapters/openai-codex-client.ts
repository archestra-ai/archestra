/**
 * ChatGPT/Codex subscription client for the OpenAI provider's "ChatGPT
 * subscription" auth mode.
 *
 * The OpenAI proxy adapter (adapters/openai.ts) only ever calls
 * `client.chat.completions.create(params)`. When the resolved credential is a
 * ChatGPT-subscription credential, `createClient` returns this object instead of
 * the real OpenAI SDK: it duck-types that single method and, per request,
 *  - builds a Codex Responses request (store:false, stream:true, codex
 *    instructions, encrypted reasoning) from the inbound chat-completions body;
 *  - calls the ChatGPT Codex backend's Responses API through the real OpenAI SDK
 *    pointed at `chatgpt.com/backend-api/codex`, authenticated by a fetch wrapper
 *    that swaps in a fresh OAuth access token and the ChatGPT identity headers
 *    (see services/openai-codex-token);
 *  - maps the Responses event stream back to OpenAI chat chunks (streaming) or a
 *    chat completion (non-streaming).
 *
 * Mirrors the Microsoft 365 Copilot Graph client's duck-typing approach.
 */
import { randomUUID } from "node:crypto";
import OpenAIProvider from "openai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import config from "@/config";
import type { OpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { createOpenAiCodexFetch } from "@/services/openai-codex-token";
import type { CreateClientOptions, OpenAi } from "@/types";
import {
  buildCodexResponsesRequest,
  codexResponsesStreamToChatChunks,
  foldChatChunksToResponse,
} from "./openai-codex-translator";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;
type ChatCompletionsResponse = OpenAi.Types.ChatCompletionsResponse;
type ChatCompletionChunk = OpenAi.Types.ChatCompletionChunk;

/**
 * Builds the duck-typed Codex client the OpenAI adapter hands back for a
 * ChatGPT-subscription credential. Returned as `OpenAIProvider` because the
 * factory only touches `chat.completions.create`.
 */
export function createOpenAiCodexClient(params: {
  credential: OpenAiCodexCredential;
  options: CreateClientOptions;
  innerFetch?: FetchLike;
}): OpenAIProvider {
  const { credential, options, innerFetch } = params;
  const client = new OpenAiCodexClient({ credential, options, innerFetch });
  return client as unknown as OpenAIProvider;
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class OpenAiCodexClient {
  chat = {
    completions: {
      create: (
        params: ChatCompletionsRequest & { stream?: boolean },
      ): Promise<
        ChatCompletionsResponse | AsyncIterable<ChatCompletionChunk>
      > => this.createCompletion(params),
    },
  };

  private openai: OpenAIProvider;

  constructor(params: {
    credential: OpenAiCodexCredential;
    options: CreateClientOptions;
    innerFetch?: FetchLike;
  }) {
    const { credential, options, innerFetch } = params;
    this.openai = new OpenAIProvider({
      // The Codex backend authenticates via the fetch wrapper's OAuth bearer;
      // the SDK still needs a non-empty key.
      apiKey: "chatgpt-oauth",
      // Always the Codex backend — a per-key base URL (meant for api.openai.com
      // proxies) would misroute the subscription request. Override only via the
      // dedicated codex env config.
      baseURL: config.llm.openai.codex.apiBaseUrl,
      // A stable per-client session id for the Codex `session_id` header.
      fetch: createOpenAiCodexFetch({
        credential,
        providerApiKeyId: options.llmProviderApiKeyId,
        sessionId: randomUUID(),
        innerFetch,
      }),
    });
  }

  private async createCompletion(
    params: ChatCompletionsRequest & { stream?: boolean },
  ): Promise<ChatCompletionsResponse | AsyncIterable<ChatCompletionChunk>> {
    const wantsStream = params.stream === true;
    const codexBody = buildCodexResponsesRequest(params);

    // Always stream upstream — the Codex backend requires it.
    const upstream = (await this.openai.responses.create(
      codexBody,
    )) as unknown as AsyncIterable<ResponseStreamEvent>;

    const completionId = `chatcmpl-${randomUUID()}`;
    const createdUnixSeconds = Math.floor(Date.now() / 1000);
    const chunks = codexResponsesStreamToChatChunks({
      stream: upstream,
      model: params.model,
      completionId,
      createdUnixSeconds,
    });

    if (wantsStream) {
      return chunks;
    }

    return foldChatChunksToResponse({
      chunks,
      model: params.model,
      completionId,
      createdUnixSeconds,
    });
  }
}
