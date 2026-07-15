import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { createOpenAiCodexResponsesClient } from "./openai-codex-responses-client";

const CREDENTIAL: OpenAiCodexCredential = {
  refreshToken: "rt_secret",
  accountId: "acc_123",
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
});
