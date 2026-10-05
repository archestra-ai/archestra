import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiCodexCredential } from "@/services/openai-codex-credentials";
import type { OpenAiCodexPassthrough } from "@/types";
import { openaiAdapterFactory } from "./openai";
import {
  createOpenAiCodexPassthroughResponsesClient,
  createOpenAiCodexResponsesClient,
} from "./openai-codex-responses-client";

const CREDENTIAL: OpenAiCodexCredential = {
  refreshToken: "rt_secret",
  accountId: "acc_123",
};

const PASSTHROUGH_CREDENTIAL: OpenAiCodexPassthrough = {
  accessToken: "at_ephemeral",
  accountId: "acc_ephemeral",
  residency: "us",
  originator: "opencode",
  sessionId: "session_ephemeral",
  userAgent: "opencode/test",
};

const COMPACTED_RESPONSE = {
  id: "resp_compact",
  object: "response.compaction",
  created_at: 1,
  output: [
    {
      type: "compaction",
      encrypted_content: "opaque-provider-ciphertext",
    },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 4,
    total_tokens: 24,
  },
};

/** A Responses-API SSE body the OpenAI SDK's stream parser can consume. */
function sseResponse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type CodexResponsesClient = {
  responses: {
    create: (request: Record<string, unknown>) => Promise<unknown>;
    compact: (request: Record<string, unknown>) => Promise<unknown>;
  };
};

describe("createOpenAiCodexResponsesClient", () => {
  beforeEach(() => {
    // Global fetch backs the OAuth token redemption; the Codex request itself
    // goes through the injected innerFetch so we can inspect it.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: "at_fresh", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards to the Codex backend with the mandatory transforms and streams events back", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const innerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedBody = JSON.parse(init?.body as string);
        return sseResponse([
          { type: "response.output_text.delta", delta: "Hi" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ]);
      },
    );

    const client = createOpenAiCodexResponsesClient({
      credential: CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;

    const stream = (await client.responses.create({
      model: "gpt-5.6-sol",
      input: "hi",
      stream: true,
    })) as AsyncIterable<{ type: string }>;

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }

    // Routed to the Codex backend, never api.openai.com.
    expect(capturedUrl).toContain("chatgpt.com");
    expect(capturedUrl).toContain("/responses");
    // Mandatory Codex transforms applied to the forwarded request.
    expect(capturedBody?.store).toBe(false);
    expect(capturedBody?.stream).toBe(true);
    expect(capturedBody?.include).toContain("reasoning.encrypted_content");
    // Responses events are passed through unchanged.
    expect(types).toContain("response.completed");
  });

  it("strips max_output_tokens, which the Codex backend rejects as unsupported", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const innerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);
        return sseResponse([
          { type: "response.completed", response: { id: "resp_3" } },
        ]);
      },
    );

    const client = createOpenAiCodexResponsesClient({
      credential: CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;

    const stream = (await client.responses.create({
      model: "gpt-5.6-sol",
      input: "hi",
      stream: true,
      max_output_tokens: 32768,
    })) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // drain
    }

    expect(capturedBody).toBeDefined();
    expect("max_output_tokens" in (capturedBody ?? {})).toBe(false);
  });

  it("folds the stream into the final response for a non-streaming caller", async () => {
    const innerFetch = vi.fn(async () =>
      sseResponse([
        {
          type: "response.completed",
          response: { id: "resp_2", status: "completed", output: [] },
        },
      ]),
    );

    const client = createOpenAiCodexResponsesClient({
      credential: CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;

    const response = (await client.responses.create({
      model: "gpt-5.6-sol",
      input: "hi",
      stream: false,
    })) as { id: string };

    expect(response.id).toBe("resp_2");
  });

  describe("upstream errors", () => {
    async function createRejection(upstream: Response) {
      const client = createOpenAiCodexResponsesClient({
        credential: CREDENTIAL,
        options: { source: "api" },
        innerFetch: vi.fn(async () => upstream),
      }) as unknown as CodexResponsesClient;
      return client.responses
        .create({ model: "gpt-5.4", input: "hi", stream: true })
        .then(
          () => {
            throw new Error("expected the request to fail");
          },
          (error: unknown) => error,
        );
    }

    it("keeps a top-level detail as the error message", async () => {
      const detail =
        "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.";
      const error = await createRejection(
        Response.json({ detail }, { status: 400 }),
      );

      expect(error).toMatchObject({ status: 400 });
      expect(openaiAdapterFactory.extractErrorMessage(error)).toBe(detail);
    });

    it("falls back to the generic message for an empty error body", async () => {
      const error = await createRejection(new Response(null, { status: 400 }));

      expect(error).toMatchObject({ status: 400 });
      expect(openaiAdapterFactory.extractErrorMessage(error)).toBe(
        "400 status code (no body)",
      );
    });
  });

  describe("prompt cache session", () => {
    // The proxy builds a new client for every request, so each call here
    // stands for one request of a run.
    async function sendRequest(params: {
      sessionId?: string;
      promptCacheKey?: string;
    }) {
      let sent: { sessionHeader: string | null; promptCacheKey: unknown } = {
        sessionHeader: null,
        promptCacheKey: undefined,
      };
      const innerFetch = vi.fn(
        async (_input: string | URL | Request, init?: RequestInit) => {
          sent = {
            sessionHeader: new Headers(init?.headers).get("session-id"),
            promptCacheKey: JSON.parse(init?.body as string).prompt_cache_key,
          };
          return sseResponse([
            {
              type: "response.completed",
              response: { id: "resp_cache", status: "completed", output: [] },
            },
          ]);
        },
      );
      const client = createOpenAiCodexResponsesClient({
        credential: CREDENTIAL,
        options: { source: "api", sessionId: params.sessionId },
        innerFetch,
      }) as unknown as CodexResponsesClient;
      await client.responses.create({
        model: "gpt-5.6-luna",
        input: "hi",
        stream: false,
        ...(params.promptCacheKey
          ? { prompt_cache_key: params.promptCacheKey }
          : {}),
      });
      return sent;
    }

    it("keeps the caller's own prompt_cache_key", async () => {
      const sent = await sendRequest({
        sessionId: "run-1",
        promptCacheKey: "caller-key",
      });

      expect(sent.promptCacheKey).toBe("caller-key");
    });

    it("uses a new session for each request when the caller names none", async () => {
      const first = await sendRequest({});
      const second = await sendRequest({});

      expect(first.sessionHeader).not.toBe(second.sessionHeader);
      expect(first.promptCacheKey).toBeUndefined();
    });

    it("gives a compact request the session's cache key unless the caller sent one", async () => {
      const sendCompact = async (promptCacheKey?: string) => {
        let sent: { sessionHeader: string | null; promptCacheKey: unknown } = {
          sessionHeader: null,
          promptCacheKey: undefined,
        };
        const innerFetch = vi.fn(
          async (_input: string | URL | Request, init?: RequestInit) => {
            sent = {
              sessionHeader: new Headers(init?.headers).get("session-id"),
              promptCacheKey: JSON.parse(init?.body as string).prompt_cache_key,
            };
            return new Response(JSON.stringify(COMPACTED_RESPONSE), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        );
        const client = createOpenAiCodexResponsesClient({
          credential: CREDENTIAL,
          options: { source: "api", sessionId: "run-1" },
          innerFetch,
        }) as unknown as CodexResponsesClient;
        await client.responses.compact({
          model: "gpt-5.6-sol",
          input: [{ type: "compaction", encrypted_content: "previous-cipher" }],
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        });
        return sent;
      };

      const fromSession = await sendCompact();
      const fromCaller = await sendCompact("caller-key");

      expect(fromSession.promptCacheKey).toBe(fromSession.sessionHeader);
      expect(fromCaller.promptCacheKey).toBe("caller-key");
    });
  });

  it("forwards native compact requests through stored subscription auth", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const innerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(COMPACTED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const client = createOpenAiCodexResponsesClient({
      credential: CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;
    const request = {
      model: "gpt-5.6-sol",
      input: [{ type: "compaction", encrypted_content: "previous-cipher" }],
      instructions: "Compact this history.",
      previous_response_id: "resp_previous",
      prompt_cache_key: "compact-cache",
    };

    await expect(client.responses.compact(request)).resolves.toEqual(
      COMPACTED_RESPONSE,
    );
    expect(new URL(capturedUrl ?? "http://invalid").pathname).toMatch(
      /\/responses\/compact$/,
    );
    expect(capturedBody).toEqual(request);
    expect(capturedBody).not.toHaveProperty("stream");
    expect(capturedBody).not.toHaveProperty("store");
    expect(capturedBody).not.toHaveProperty("include");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer at_fresh");
    expect(capturedHeaders?.get("chatgpt-account-id")).toBe("acc_123");
    expect(capturedHeaders?.get("openai-beta")).toBe("responses=experimental");
  });

  it("forwards only request-local OAuth headers without refreshing or persisting them", async () => {
    let capturedHeaders: Headers | undefined;
    const innerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = new Headers(init?.headers);
        return sseResponse([
          {
            type: "response.completed",
            response: {
              id: "resp_passthrough",
              status: "completed",
              output: [],
            },
          },
        ]);
      },
    );
    const client = createOpenAiCodexPassthroughResponsesClient({
      credential: PASSTHROUGH_CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;

    const stream = (await client.responses.create({
      model: "gpt-5.6-sol",
      input: "hi",
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _event of stream) {
      // drain
    }

    expect(capturedHeaders).toMatchObject({
      get: expect.any(Function),
    });
    expect(capturedHeaders?.get("authorization")).toBe("Bearer at_ephemeral");
    expect(capturedHeaders?.get("chatgpt-account-id")).toBe("acc_ephemeral");
    expect(capturedHeaders?.get("x-openai-internal-codex-residency")).toBe(
      "us",
    );
    expect(capturedHeaders?.get("originator")).toBe("opencode");
    expect(capturedHeaders?.get("session-id")).toBe("session_ephemeral");
    expect(capturedHeaders?.get("user-agent")).toBe("opencode/test");
    expect(capturedHeaders?.get("openai-beta")).toBe("responses=experimental");
    // The injected request transport is the only fetch path. A bridge request
    // must never redeem/rotate an OAuth token through the global token endpoint.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("forwards Codex's version even when its custom provider omits that header", async () => {
    const versions: Array<string | null> = [];
    const innerFetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        versions.push(new Headers(init?.headers).get("version"));
        return sseResponse([
          {
            type: "response.completed",
            response: { id: "resp_version", status: "completed", output: [] },
          },
        ]);
      },
    );
    for (const { originator, version } of [
      { originator: "codex_cli_rs", version: undefined },
      { originator: "codex_exec", version: undefined },
      { originator: "codex_exec", version: "0.157.2" },
    ]) {
      const client = createOpenAiCodexPassthroughResponsesClient({
        credential: {
          ...PASSTHROUGH_CREDENTIAL,
          originator,
          userAgent: `${originator}/0.156.1`,
          version,
        },
        options: { source: "api" },
        innerFetch,
      }) as unknown as CodexResponsesClient;
      const stream = (await client.responses.create({
        model: "gpt-5.6-sol",
        input: "hi",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _event of stream) {
        // drain
      }
    }

    expect(versions).toEqual(["0.156.1", "0.156.1", "0.157.2"]);
  });

  it("forwards native compact requests through request-local OAuth", async () => {
    let capturedUrl: string | undefined;
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const innerFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(COMPACTED_RESPONSE), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const client = createOpenAiCodexPassthroughResponsesClient({
      credential: PASSTHROUGH_CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;
    const request = {
      model: "gpt-5.6-sol",
      input: "history",
      previous_response_id: "resp_previous",
    };

    await expect(client.responses.compact(request)).resolves.toEqual(
      COMPACTED_RESPONSE,
    );
    expect(new URL(capturedUrl ?? "http://invalid").pathname).toMatch(
      /\/responses\/compact$/,
    );
    expect(capturedBody).toEqual(request);
    expect(capturedHeaders?.get("authorization")).toBe("Bearer at_ephemeral");
    expect(capturedHeaders?.get("chatgpt-account-id")).toBe("acc_ephemeral");
    expect(capturedHeaders?.get("x-openai-internal-codex-residency")).toBe(
      "us",
    );
    expect(capturedHeaders?.get("originator")).toBe("opencode");
    expect(capturedHeaders?.get("session-id")).toBe("session_ephemeral");
    expect(capturedHeaders?.get("user-agent")).toBe("opencode/test");
    expect(capturedHeaders?.get("openai-beta")).toBe("responses=experimental");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps a top-level detail as the error message", async () => {
    const detail = "The 'gpt-5.4' model is not supported.";
    const client = createOpenAiCodexPassthroughResponsesClient({
      credential: PASSTHROUGH_CREDENTIAL,
      options: { source: "api" },
      innerFetch: vi.fn(async () => Response.json({ detail }, { status: 400 })),
    }) as unknown as CodexResponsesClient;

    const error = await client.responses
      .create({ model: "gpt-5.4", input: "hi", stream: true })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 400 });
    expect(openaiAdapterFactory.extractErrorMessage(error)).toBe(detail);
  });

  it("relays an upstream 401 without retrying the request", async () => {
    const innerFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createOpenAiCodexPassthroughResponsesClient({
      credential: PASSTHROUGH_CREDENTIAL,
      options: { source: "api" },
      innerFetch,
    }) as unknown as CodexResponsesClient;

    await expect(
      client.responses.create({
        model: "gpt-5.6-sol",
        input: "hi",
        stream: true,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(innerFetch).toHaveBeenCalledTimes(1);
  });
});
