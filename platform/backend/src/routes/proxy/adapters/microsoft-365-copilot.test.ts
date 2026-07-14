import { ArchestraInternalErrorCode, TimeInMs } from "@archestra/shared";
import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";
import type { OpenAi } from "@/types";
import { microsoft365CopilotAdapterFactory } from "./microsoft-365-copilot";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;
type ChatCompletionsResponse = OpenAi.Types.ChatCompletionsResponse;
type ChatCompletionChunk = OpenAi.Types.ChatCompletionChunk;

const MODEL = "microsoft-365-copilot";
const TOKEN_URL_MARKER = "/oauth2/v2.0/token";
const CONVERSATIONS_URL_MARKER = "/copilot/conversations";

/**
 * The token manager is a module singleton with an internal cache, so every
 * test uses a unique refresh token to stay isolated.
 */
let tokenCounter = 0;
function uniqueRefreshToken(): string {
  tokenCounter += 1;
  return `entra_rt_client_${Date.now()}_${tokenCounter}`;
}

function makeRequest(
  overrides: Partial<ChatCompletionsRequest> = {},
): ChatCompletionsRequest {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "What is on my calendar?" }],
    ...overrides,
  } as ChatCompletionsRequest;
}

function graphConversation(id = "conv-1") {
  return Response.json({ id, state: "active", turnCount: 0 }, { status: 201 });
}

function graphChatAnswer(text: string) {
  return Response.json({
    id: "conv-1",
    turnCount: 1,
    messages: [
      {
        "@odata.type": "#microsoft.graph.copilotConversationRequestMessage",
        text: "What is on my calendar?",
      },
      {
        "@odata.type": "#microsoft.graph.copilotConversationResponseMessage",
        text,
        adaptiveCards: [],
        attributions: [],
      },
    ],
  });
}

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Routes the stubbed global fetch: Entra token redemptions, conversation
 * creation, and the chat/chatOverStream turn endpoints.
 */
function stubGraphFetch(handlers: {
  chat?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  chatOverStream?: (
    url: string,
    init?: RequestInit,
  ) => Response | Promise<Response>;
  createConversation?: () => Response;
}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes(TOKEN_URL_MARKER)) {
        return Response.json({
          access_token: "graph-access-token",
          expires_in: 3600,
        });
      }
      if (url.endsWith("/chatOverStream")) {
        if (!handlers.chatOverStream) {
          throw new Error(`unexpected chatOverStream call: ${url}`);
        }
        return handlers.chatOverStream(url, init);
      }
      if (url.endsWith("/chat")) {
        if (!handlers.chat) {
          throw new Error(`unexpected chat call: ${url}`);
        }
        return handlers.chat(url, init);
      }
      if (url.endsWith(CONVERSATIONS_URL_MARKER)) {
        return (handlers.createConversation ?? graphConversation)();
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

function createClient(abortSignal?: AbortSignal) {
  return microsoft365CopilotAdapterFactory.createClient(uniqueRefreshToken(), {
    abortSignal,
    source: "api",
  });
}

async function collectChunks(
  iterable: AsyncIterable<ChatCompletionChunk>,
): Promise<ChatCompletionChunk[]> {
  const chunks: ChatCompletionChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  return chunks;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("microsoft365CopilotAdapterFactory execute (non-streaming)", () => {
  test("creates a conversation, sends the chat turn, and maps the answer to an OpenAI completion", async () => {
    const { calls } = stubGraphFetch({
      chat: () => graphChatAnswer("Your 9 AM is quarterly planning."),
    });

    const response = (await microsoft365CopilotAdapterFactory.execute(
      createClient(),
      makeRequest({
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "What is on my calendar?" },
        ],
      }),
    )) as ChatCompletionsResponse;

    expect(response.object).toBe("chat.completion");
    expect(response.model).toBe(MODEL);
    expect(response.choices[0].message.content).toBe(
      "Your 9 AM is quarterly planning.",
    );
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage?.prompt_tokens).toBeGreaterThan(0);
    expect(response.usage?.completion_tokens).toBeGreaterThan(0);

    const chatCall = calls.find(({ url }) => url.endsWith("/chat"));
    expect(chatCall).toBeDefined();
    expect(chatCall?.url).toContain("/copilot/conversations/conv-1/chat");
    const graphBody = JSON.parse(String(chatCall?.init?.body)) as {
      message: { text: string };
      additionalContext?: Array<{ text: string }>;
    };
    expect(graphBody.message.text).toBe("What is on my calendar?");
    expect(graphBody.additionalContext?.[0].text).toContain("Be brief.");
    // The redeemed access token — never the raw refresh token — goes upstream.
    const headers = chatCall?.init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer graph-access-token");
  });

  test("rejects declared tools with a 400 before any Graph call", async () => {
    const { fetchMock } = stubGraphFetch({});

    await expect(
      microsoft365CopilotAdapterFactory.execute(
        createClient(),
        makeRequest({
          tools: [
            {
              type: "function",
              function: { name: "read_file", parameters: {} },
            },
          ],
        } as Partial<ChatCompletionsRequest>),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("does not support tool calling"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces Graph errors with their real status and message", async () => {
    stubGraphFetch({
      chat: () =>
        Response.json(
          {
            error: {
              code: "Forbidden",
              message: "User does not have a Microsoft 365 Copilot license.",
            },
          },
          { status: 403 },
        ),
    });

    await expect(
      microsoft365CopilotAdapterFactory.execute(createClient(), makeRequest()),
    ).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("Copilot license"),
    });
  });
});

describe("microsoft365CopilotAdapterFactory executeStream", () => {
  test("translates SSE events carrying cumulative snapshots into content deltas", async () => {
    stubGraphFetch({
      chatOverStream: () =>
        sseResponse([
          JSON.stringify({ messages: [{ text: "Hello" }] }),
          JSON.stringify({ messages: [{ text: "Hello there" }] }),
          "[DONE]",
        ]),
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });
    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["Hello", " there"]);
    const finish = chunks.at(-1);
    expect(finish?.choices[0].finish_reason).toBe("stop");
    expect(finish?.usage?.completion_tokens).toBeGreaterThan(0);
  });

  test("treats non-prefix event texts as true deltas", async () => {
    stubGraphFetch({
      chatOverStream: () =>
        sseResponse([
          JSON.stringify({ text: "Hel" }),
          JSON.stringify({ text: "lo" }),
        ]),
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["Hel", "lo"]);
  });

  test("emits a final event that ends without a trailing newline, even with a multi-byte character split across chunks", async () => {
    const encoder = new TextEncoder();
    const tail = encoder.encode(`data: ${JSON.stringify({ text: "café" })}`);
    // Split inside é's two-byte UTF-8 sequence; the stream then ends with no
    // newline after the last event.
    const splitAt = tail.length - 3;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ text: "Hel" })}\n\n`),
        );
        controller.enqueue(tail.slice(0, splitAt));
        controller.enqueue(tail.slice(splitAt));
        controller.close();
      },
    });
    stubGraphFetch({
      chatOverStream: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["Hel", "café"]);
  });

  test("fabricates chunks from a non-SSE Graph answer without a second conversation", async () => {
    const { calls } = stubGraphFetch({
      chatOverStream: () => graphChatAnswer("non-streamed answer"),
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["non-streamed answer"]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe("stop");
    expect(
      calls.filter(({ url }) => url.endsWith(CONVERSATIONS_URL_MARKER)),
    ).toHaveLength(1);
    expect(calls.some(({ url }) => url.endsWith("/chat"))).toBe(false);
  });

  test("falls back to the sync endpoint when SSE yields no recognizable text", async () => {
    let conversationCount = 0;
    const { calls } = stubGraphFetch({
      chatOverStream: () =>
        sseResponse([JSON.stringify({ unrecognized: "event-shape" })]),
      chat: () => graphChatAnswer("salvaged answer"),
      createConversation: () => {
        conversationCount += 1;
        return graphConversation(`conv-${conversationCount}`);
      },
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["salvaged answer"]);
    // The fallback runs on a fresh conversation via the sync endpoint.
    expect(
      calls.filter(({ url }) => url.endsWith(CONVERSATIONS_URL_MARKER)),
    ).toHaveLength(2);
    expect(
      calls.find(({ url }) => url.endsWith("/chatOverStream"))?.url,
    ).toContain("/conv-1/chatOverStream");
    expect(calls.find(({ url }) => url.endsWith("/chat"))?.url).toContain(
      "/conv-2/chat",
    );
  });

  test("cancels and sync-falls back when metadata-only SSE exceeds the text-progress deadline", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const lifecycle: string[] = [];
    let heartbeat: NodeJS.Timeout | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Raw bytes continue to arrive, but none contain recognizable answer
        // text. They must not reset the semantic progress deadline.
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode('data: {"kind":"heartbeat"}\n\n'));
        }, 30 * TimeInMs.Second);
      },
      cancel() {
        clearInterval(heartbeat);
        lifecycle.push("stream-canceled");
      },
    });
    let conversationCount = 0;
    stubGraphFetch({
      chatOverStream: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      chat: () => {
        lifecycle.push("sync-chat");
        return graphChatAnswer("safe fallback answer");
      },
      createConversation: () => {
        conversationCount += 1;
        return graphConversation(`conv-${conversationCount}`);
      },
    });

    const iterable = await microsoft365CopilotAdapterFactory.executeStream(
      createClient(),
      makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
    );
    const outcome = collectChunks(iterable);

    await vi.advanceTimersByTimeAsync(2 * TimeInMs.Minute);

    const chunks = await outcome;
    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["safe fallback answer"]);
    expect(lifecycle).toEqual(["stream-canceled", "sync-chat"]);
    expect(conversationCount).toBe(2);
  });

  test("cancels an open SSE body after the done event", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ text: "complete" })}\n\ndata: [DONE]\n\n`,
          ),
        );
      },
      cancel,
    });
    stubGraphFetch({
      chatOverStream: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const chunks = await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const contentDeltas = chunks
      .map((chunk) => chunk.choices[0]?.delta?.content)
      .filter((content): content is string => Boolean(content));
    expect(contentDeltas).toEqual(["complete"]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  test("cancels an open SSE body when the consumer stops after the role chunk", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    stubGraphFetch({
      chatOverStream: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const iterable = await microsoft365CopilotAdapterFactory.executeStream(
      createClient(),
      makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
    );
    const iterator = iterable[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.value?.choices[0].delta).toMatchObject({ role: "assistant" });
    await iterator.return?.();

    expect(cancel).toHaveBeenCalledOnce();
  });

  test("fails a text-stalled stream with a retryable 504, cancels it, and never splices in a sync answer", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let heartbeat: NodeJS.Timeout | undefined;
    const cancel = vi.fn(() => clearInterval(heartbeat));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ text: "Once upon a" })}\n\n`,
          ),
        );
        // Metadata keeps the raw reader active, but does not advance the
        // answer. The semantic timeout must still fire.
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode('data: {"kind":"heartbeat"}\n\n'));
        }, 30 * TimeInMs.Second);
      },
      cancel,
    });
    const syncChat = vi.fn(() => graphChatAnswer("different sync answer"));
    const { calls } = stubGraphFetch({
      chatOverStream: () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      chat: syncChat,
    });

    const iterable = await microsoft365CopilotAdapterFactory.executeStream(
      createClient(),
      makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
    );
    // Attach handlers before advancing the clock so the rejection is observed
    // (never an unhandled rejection).
    const outcome = collectChunks(iterable).then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(2 * TimeInMs.Minute);

    const error = await outcome;
    expect(error).toMatchObject({
      status: 504,
      statusCode: 504,
      internalCode: ArchestraInternalErrorCode.UpstreamTimeout,
      message: expect.stringContaining("upstream idle timeout"),
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(syncChat).not.toHaveBeenCalled();
    expect(calls.some(({ url }) => url.endsWith("/chat"))).toBe(false);
  });

  test("forwards a downstream abort signal to Graph conversation and stream requests", async () => {
    const abortController = new AbortController();
    const { calls } = stubGraphFetch({
      chatOverStream: () =>
        sseResponse([JSON.stringify({ text: "complete" }), "[DONE]"]),
    });

    await collectChunks(
      await microsoft365CopilotAdapterFactory.executeStream(
        createClient(abortController.signal),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    );

    const graphCalls = calls.filter(({ url }) =>
      url.includes(CONVERSATIONS_URL_MARKER),
    );
    expect(graphCalls).toHaveLength(2);
    expect(
      graphCalls.every(({ init }) => init?.signal === abortController.signal),
    ).toBe(true);
  });

  test("surfaces a Graph error on the stream request as a clean error before any chunk", async () => {
    stubGraphFetch({
      chatOverStream: () =>
        Response.json(
          { error: { code: "Unauthorized", message: "token rejected" } },
          { status: 401 },
        ),
    });

    await expect(
      microsoft365CopilotAdapterFactory.executeStream(
        createClient(),
        makeRequest({ stream: true } as Partial<ChatCompletionsRequest>),
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
