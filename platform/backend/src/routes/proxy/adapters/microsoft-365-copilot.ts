/**
 * Microsoft 365 Copilot LLM Proxy Adapter
 *
 * The proxy's inbound wire format is OpenAI chat completions, so the whole
 * adapter is OpenAI's, configured via createOpenAiCompatibleAdapterFactory.
 * Upstream, however, is NOT OpenAI-compatible: it is the Microsoft 365
 * Copilot Chat API (Microsoft Graph beta) — stateful conversations, text-only
 * answers, no tool calling, no model selection, no usage counts. The factory
 * only ever calls `client.chat.completions.create(params)`, so instead of the
 * real OpenAI SDK the client below duck-types that single method and performs
 * the Graph translation (see ./microsoft-365-copilot-graph-translator):
 *
 * - per request: create a fresh Graph conversation, send the latest user
 *   message as the prompt with prior turns as additional context;
 * - non-streaming: `POST …/chat`, mapped to an OpenAI `chat.completion`;
 * - streaming: `POST …/chatOverStream` (SSE) parsed defensively into OpenAI
 *   chunks — a non-SSE Graph answer is converted directly, while an SSE stream
 *   with no recognizable text is retried through the sync endpoint; a stream
 *   that goes silent mid-answer is failed with a 504 (see
 *   STREAM_IDLE_TIMEOUT_MS) instead of blocking its chat run indefinitely;
 * - auth: the incoming "API key" is the user's long-lived Entra ID refresh
 *   token, swapped per request for a short-lived Graph access token inside a
 *   fetch wrapper (see services/microsoft-365-copilot-token), because
 *   `createClient` is synchronous.
 */
import { randomUUID } from "node:crypto";
import type OpenAIProvider from "openai";
import config from "@/config";
import logger from "@/logging";
import { metrics } from "@/observability";
import { createMicrosoft365CopilotFetch } from "@/services/microsoft-365-copilot-token";
import type { CreateClientOptions, OpenAi } from "@/types";
import {
  assertNoTools,
  buildGraphChatBody,
  completionTextToChunks,
  estimateUsage,
  extractGraphResponseText,
  type GraphChatBody,
  graphChatResponseToOpenAi,
  makeContentDeltaChunk,
  makeFinishChunk,
  makeRoleChunk,
} from "./microsoft-365-copilot-graph-translator";
import { createOpenAiCompatibleAdapterFactory } from "./openai-compatible-adapter";

export const microsoft365CopilotAdapterFactory =
  createOpenAiCompatibleAdapterFactory({
    provider: "microsoft-365-copilot",
    interactionType: "microsoft-365-copilot:chatCompletions",
    getBaseUrl: () => config.llm["microsoft-365-copilot"].baseUrl,
    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): OpenAIProvider {
      const observableFetch = options.agent
        ? metrics.llm.getObservableFetch(
            "microsoft-365-copilot",
            options.agent,
            options.source,
          )
        : undefined;

      const client = new Microsoft365CopilotGraphClient({
        baseUrl: options.baseUrl ?? config.llm["microsoft-365-copilot"].baseUrl,
        fetch: createMicrosoft365CopilotFetch({
          refreshToken: apiKey,
          providerApiKeyId: options.llmProviderApiKeyId,
          innerFetch: observableFetch,
        }),
      });
      // The factory only calls `chat.completions.create`, which the Graph
      // client duck-types; it never touches other OpenAI SDK surface.
      return client as unknown as OpenAIProvider;
    },
  });

// ===== Internal helpers =====

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;
type ChatCompletionsResponse = OpenAi.Types.ChatCompletionsResponse;
type ChatCompletionChunk = OpenAi.Types.ChatCompletionChunk;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

class Microsoft365CopilotGraphClient {
  chat = {
    completions: {
      create: (
        params: ChatCompletionsRequest & { stream?: boolean },
      ): Promise<
        ChatCompletionsResponse | AsyncIterable<ChatCompletionChunk>
      > => this.createCompletion(params),
    },
  };

  private baseUrl: string;
  private fetch: FetchLike;

  constructor(params: { baseUrl: string; fetch: FetchLike }) {
    this.baseUrl = params.baseUrl.replace(/\/+$/, "");
    this.fetch = params.fetch;
  }

  private async createCompletion(
    params: ChatCompletionsRequest & { stream?: boolean },
  ): Promise<ChatCompletionsResponse | AsyncIterable<ChatCompletionChunk>> {
    assertNoTools(params);
    const graphBody = buildGraphChatBody(params);
    if (params.stream) {
      return this.streamCompletion(params, graphBody);
    }
    return this.syncCompletion(params, graphBody);
  }

  private async syncCompletion(
    params: ChatCompletionsRequest,
    graphBody: GraphChatBody,
  ): Promise<ChatCompletionsResponse> {
    const responseText = await this.runSyncChat(graphBody);
    return graphChatResponseToOpenAi({
      responseText,
      model: params.model,
      completionId: newCompletionId(),
      createdUnixSeconds: nowUnixSeconds(),
      usage: estimateUsage({ request: params, responseText }),
    });
  }

  /**
   * Opens the chatOverStream request eagerly (so auth/Graph errors surface as
   * clean HTTP errors before any chunk is emitted), then returns the chunk
   * iterator. Converts a non-SSE Graph answer directly, or falls back to the
   * sync endpoint — on a fresh conversation — when an SSE stream yields no
   * recognizable text.
   */
  private async streamCompletion(
    params: ChatCompletionsRequest,
    graphBody: GraphChatBody,
  ): Promise<AsyncIterable<ChatCompletionChunk>> {
    const conversationId = await this.createConversation();
    const response = await this.fetch(
      `${this.conversationsUrl()}/${conversationId}/chatOverStream`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(graphBody),
      },
    );
    if (!response.ok) {
      await throwGraphError(response);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Some deployments may answer the stream endpoint with a plain JSON
      // conversation payload; salvage it before resorting to a second call.
      const responseText = await this.readNonSseAnswer(response);
      return this.fabricatedChunks(params, responseText);
    }

    const completionId = newCompletionId();
    const createdUnixSeconds = nowUnixSeconds();
    const self = this;

    return {
      [Symbol.asyncIterator]: async function* () {
        let eventParsingStarted = false;
        try {
          yield makeRoleChunk({
            model: params.model,
            completionId,
            createdUnixSeconds,
          });
          eventParsingStarted = true;
        } finally {
          // If the downstream consumer stops at the role chunk, the SSE parser
          // never acquires a reader and therefore cannot cancel the body.
          if (!eventParsingStarted) {
            await response.body?.cancel();
          }
        }

        let emittedText = "";
        for await (const eventData of parseSseEvents(response)) {
          if (eventData === "[DONE]") break;
          let payload: unknown;
          try {
            payload = JSON.parse(eventData);
          } catch {
            continue; // tolerate keep-alives and unknown non-JSON events
          }
          const candidate = extractGraphResponseText(payload);
          if (candidate === undefined || candidate.length === 0) continue;
          // Works for both cumulative snapshots (emit the new suffix) and
          // true deltas (emit verbatim).
          const delta = candidate.startsWith(emittedText)
            ? candidate.slice(emittedText.length)
            : candidate;
          if (delta.length === 0) continue;
          emittedText += delta;
          yield makeContentDeltaChunk({
            deltaText: delta,
            model: params.model,
            completionId,
            createdUnixSeconds,
          });
        }

        if (emittedText.length === 0) {
          // Undocumented/unrecognized stream shape: answer via the sync
          // endpoint instead (fresh conversation) so the client still gets a
          // valid completion. The retry shows up as a second conversation in
          // the user's Microsoft 365 activity — unavoidable given the API's
          // statefulness, and free under seat licensing (revisit if Microsoft
          // ever bills per conversation).
          logger.warn(
            "[Microsoft365Copilot] chatOverStream yielded no recognizable text; falling back to the sync chat endpoint",
          );
          const responseText = await self.runSyncChat(graphBody);
          const chunks = completionTextToChunks({
            responseText,
            model: params.model,
            completionId,
            createdUnixSeconds,
            usage: estimateUsage({ request: params, responseText }),
          });
          // The role chunk was already emitted above.
          for (const chunk of chunks.slice(1)) {
            yield chunk;
          }
          return;
        }

        yield makeFinishChunk({
          model: params.model,
          completionId,
          createdUnixSeconds,
          usage: estimateUsage({ request: params, responseText: emittedText }),
        });
      },
    };
  }

  /** Creates a conversation and runs one sync chat turn, returning the text. */
  private async runSyncChat(graphBody: GraphChatBody): Promise<string> {
    const conversationId = await this.createConversation();
    const response = await this.fetch(
      `${this.conversationsUrl()}/${conversationId}/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(graphBody),
      },
    );
    if (!response.ok) {
      await throwGraphError(response);
    }
    const payload = (await response.json()) as unknown;
    const responseText = extractGraphResponseText(payload);
    if (responseText === undefined) {
      throw graphShapeError(
        "Microsoft 365 Copilot returned a response without any message text",
      );
    }
    return responseText;
  }

  private async createConversation(): Promise<string> {
    // Microsoft Graph currently documents no delete operation for Copilot
    // conversations. If the following chat request fails, this conversation
    // cannot be cleaned up and may remain visible in the user's activity.
    const response = await this.fetch(this.conversationsUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) {
      await throwGraphError(response);
    }
    const payload = (await response.json()) as { id?: string };
    if (!payload.id) {
      throw graphShapeError(
        "Microsoft 365 Copilot conversation creation returned no conversation id",
      );
    }
    return payload.id;
  }

  private async readNonSseAnswer(response: Response): Promise<string> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw graphShapeError(
        "Microsoft 365 Copilot returned a stream response in an unexpected format",
      );
    }
    const responseText = extractGraphResponseText(payload);
    if (responseText === undefined) {
      throw graphShapeError(
        "Microsoft 365 Copilot returned a response without any message text",
      );
    }
    return responseText;
  }

  private fabricatedChunks(
    params: ChatCompletionsRequest,
    responseText: string,
  ): AsyncIterable<ChatCompletionChunk> {
    const chunks = completionTextToChunks({
      responseText,
      model: params.model,
      completionId: newCompletionId(),
      createdUnixSeconds: nowUnixSeconds(),
      usage: estimateUsage({ request: params, responseText }),
    });
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  }

  private conversationsUrl(): string {
    return `${this.baseUrl}/copilot/conversations`;
  }
}

function newCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Throws a Graph error in the shape the shared adapter expects:
 * `status` drives the HTTP status (handleError) and `error.message` feeds
 * extractErrorMessage, so the caller sees Graph's real message (e.g. the
 * missing-Copilot-license 403) instead of a generic 500.
 */
async function throwGraphError(response: Response): Promise<never> {
  let message = `Microsoft 365 Copilot request failed with status ${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    if (typeof body?.error?.message === "string" && body.error.message) {
      message = body.error.message;
    }
  } catch {
    // Non-JSON error body; keep the generic status message.
  }
  throw Object.assign(new Error(message), {
    status: response.status,
    error: { message },
  });
}

function graphShapeError(message: string): Error {
  return Object.assign(new Error(message), {
    status: 502,
    error: { message },
  });
}

/**
 * Maximum silence tolerated on the Graph SSE stream before the request is
 * failed. chatOverStream can stall mid-answer without closing the connection;
 * unbounded, that read blocks until undici's 5-minute body timeout (or far
 * longer when ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS raises it) while the
 * conversation's active chat run stays `running` and 409-blocks every new
 * message. Failing loudly instead routes through the standard mid-stream
 * error path, which marks the run terminal so the user can retry immediately.
 */
const STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Minimal incremental SSE parser: yields each event's joined `data:` payload.
 * Tolerates comment lines, CRLF, and multi-line data fields per the SSE spec.
 * Throws a 504 when the stream stays silent for STREAM_IDLE_TIMEOUT_MS.
 */
async function* parseSseEvents(response: Response): AsyncGenerator<string> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flush = (): string | undefined => {
    if (dataLines.length === 0) return undefined;
    const data = dataLines.join("\n");
    dataLines = [];
    return data;
  };

  let reachedEnd = false;
  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader);
      if (done) {
        reachedEnd = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") {
          const data = flush();
          if (data !== undefined) yield data;
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // Other fields (event:, id:, retry:, comments) carry no payload we use.
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    try {
      if (!reachedEnd) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
  // End of stream: flush a multi-byte character split across the last chunk,
  // then treat an unterminated final line as complete. The SSE spec says to
  // discard an event not followed by a blank line, but Graph's stream shape
  // is undocumented and dropping trailing text is worse than emitting it.
  buffer += decoder.decode();
  const lastLine = buffer.replace(/\r$/, "");
  if (lastLine.startsWith("data:")) {
    dataLines.push(lastLine.slice(5).replace(/^ /, ""));
  }
  const data = flush();
  if (data !== undefined) yield data;
}

/**
 * One reader.read() bounded by STREAM_IDLE_TIMEOUT_MS of silence. On expiry
 * this throws in the adapter error shape (`status` + `error.message`, like
 * throwGraphError); parseSseEvents' cleanup then cancels the reader, which
 * releases the underlying Graph connection.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const read = reader.read();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const message = `Microsoft 365 Copilot stopped streaming a response (no data received for ${STREAM_IDLE_TIMEOUT_MS / 1000} seconds). Please try again.`;
          reject(
            Object.assign(new Error(message), {
              status: 504,
              error: { message },
            }),
          );
        }, STREAM_IDLE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // The losing read settles later (when the caller's cleanup cancels the
    // reader); observe it so it can't surface as an unhandled rejection.
    read.catch((readError) => {
      logger.debug(
        { readError },
        "[Microsoft365Copilot] late stream read failure after the idle timeout fired",
      );
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
