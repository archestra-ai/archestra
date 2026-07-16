/**
 * ChatGPT/Codex subscription client for the OpenAI provider's **Responses**
 * endpoint — the path the first-party OpenAI Codex CLI uses.
 *
 * The Codex backend natively speaks the Responses API, so — unlike the
 * chat-completions path (see ./openai-codex-client, which translates chat ⇄
 * responses) — no format translation is needed here. The inbound Responses
 * request is forwarded to the Codex backend with the mandatory transforms
 * (store:false, stream:true, encrypted reasoning) and the ChatGPT identity/auth
 * headers (see services/openai-codex-token), and the Responses event stream is
 * returned to the caller unchanged. Non-streaming callers get the final
 * Response folded from the stream's terminal `response.completed` event.
 */
import { randomUUID } from "node:crypto";
import OpenAIProvider from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import config from "@/config";
import {
  OPENAI_CODEX_INSTRUCTIONS,
  type OpenAiCodexCredential,
} from "@/services/openai-codex-credentials";
import { createOpenAiCodexFetch } from "@/services/openai-codex-token";
import { ApiError, type CreateClientOptions, type OpenAi } from "@/types";

type ResponsesRequest = OpenAi.Types.ResponsesRequest;
type ResponsesResponse = OpenAi.Types.ResponsesResponse;

/**
 * Builds the duck-typed Codex client the OpenAI Responses adapter hands back for
 * a ChatGPT-subscription credential. Returned as `OpenAIProvider` because the
 * factory only touches `responses.create`.
 */
export function createOpenAiCodexResponsesClient(params: {
  credential: OpenAiCodexCredential;
  options: CreateClientOptions;
  innerFetch?: FetchLike;
}): OpenAIProvider {
  return new OpenAiCodexResponsesClient(params) as unknown as OpenAIProvider;
}

// ===== Internal helpers =====

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class OpenAiCodexResponsesClient {
  responses = {
    create: (
      request: ResponsesRequest & { stream?: boolean },
    ): Promise<ResponsesResponse | AsyncIterable<ResponseStreamEvent>> =>
      this.create(request),
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
      // proxies) would misroute the subscription request.
      baseURL: config.llm.openai.codex.apiBaseUrl,
      fetch: createOpenAiCodexFetch({
        credential,
        providerApiKeyId: options.llmProviderApiKeyId,
        sessionId: randomUUID(),
        innerFetch,
      }),
    });
  }

  private async create(
    request: ResponsesRequest & { stream?: boolean },
  ): Promise<ResponsesResponse | AsyncIterable<ResponseStreamEvent>> {
    const wantsStream = request.stream === true;
    const codexBody = applyCodexResponsesTransforms(request);

    // The Codex backend requires streaming; accumulate for non-streaming callers.
    const upstream = (await this.openai.responses.create(
      codexBody,
    )) as unknown as AsyncIterable<ResponseStreamEvent>;

    if (wantsStream) {
      return upstream;
    }
    return foldCodexResponsesStream(upstream);
  }
}

/**
 * Applies the mandatory Codex-backend transforms to an inbound Responses request
 * without reshaping the caller's content: force `store:false`/`stream:true`, add
 * encrypted reasoning to `include`, and supply the Codex persona only when the
 * caller (e.g. a non-Codex client) omitted its own instructions.
 */
function applyCodexResponsesTransforms(
  request: ResponsesRequest & { stream?: boolean },
): ResponseCreateParamsStreaming {
  const loose = request as {
    include?: unknown;
    instructions?: string | null;
  };
  const existingInclude = Array.isArray(loose.include)
    ? (loose.include as string[])
    : [];
  return {
    ...request,
    store: false,
    stream: true,
    include: Array.from(
      new Set([...existingInclude, "reasoning.encrypted_content"]),
    ),
    instructions: loose.instructions ?? OPENAI_CODEX_INSTRUCTIONS,
  } as unknown as ResponseCreateParamsStreaming;
}

/**
 * Folds a Codex Responses event stream into the final Response for a
 * non-streaming caller. The terminal `response.completed`/`response.incomplete`
 * event already carries the complete Response object.
 */
async function foldCodexResponsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
): Promise<ResponsesResponse> {
  let final: ResponsesResponse | undefined;
  for await (const event of stream) {
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete"
    ) {
      final = event.response as unknown as ResponsesResponse;
    } else if (event.type === "response.failed") {
      const message =
        (event.response as { error?: { message?: string } }).error?.message ??
        "request failed";
      throw new ApiError(
        502,
        `ChatGPT subscription (Codex) request failed: ${message}`,
      );
    }
  }
  if (!final) {
    throw new ApiError(
      502,
      "ChatGPT subscription (Codex) returned no completed response",
    );
  }
  return final;
}
