import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { createOpenAiCodexClient } from "./openai-codex-client";

const CREDENTIAL: OpenAiCodexCredential = {
  refreshToken: "rt_secret",
  accountId: "acc_123",
};

type CodexChatClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<unknown>;
    };
  };
};

describe("createOpenAiCodexClient prompt cache session", () => {
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

  // The proxy builds a new client for every request, so each call here
  // stands for one request of a run.
  async function sendRequest(sessionId: string) {
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
        const events = [
          { type: "response.output_text.delta", delta: "Hi" },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 1, output_tokens: 1 } },
          },
        ];
        return new Response(
          events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    const client = createOpenAiCodexClient({
      credential: CREDENTIAL,
      options: { source: "api", sessionId },
      innerFetch,
    }) as unknown as CodexChatClient;
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    return sent;
  }

  it("sends one session and prompt cache key for all requests of a session", async () => {
    const first = await sendRequest("run-1");
    const second = await sendRequest("run-1");
    const otherRun = await sendRequest("run-2");

    expect(second).toEqual(first);
    expect(first.promptCacheKey).toBe(first.sessionHeader);
    expect(otherRun.sessionHeader).not.toBe(first.sessionHeader);
  });
});
