import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import { describe, expect, test } from "@/test";
import {
  applyResponseHealing,
  createResponseHealingFetch,
} from "./openrouter-response-healing";

// The literal OpenRouter plugin id we forward upstream.
const healingPlugin = { id: "response-healing" };

describe("applyResponseHealing", () => {
  test("appends the plugin for non-streaming json_schema requests", () => {
    const result = applyResponseHealing({
      response_format: { type: "json_schema" },
    });

    expect(result.plugins).toEqual([healingPlugin]);
  });

  test("appends the plugin for non-streaming json_object requests", () => {
    const result = applyResponseHealing({
      response_format: { type: "json_object" },
    });

    expect(result.plugins).toEqual([healingPlugin]);
  });

  test("preserves existing plugins when appending", () => {
    const result = applyResponseHealing({
      response_format: { type: "json_schema" },
      plugins: [{ id: "web" }],
    });

    expect(result.plugins).toEqual([{ id: "web" }, healingPlugin]);
  });

  test("does not inject on streaming requests", () => {
    const request = {
      stream: true,
      response_format: { type: "json_schema" },
    };

    expect(applyResponseHealing(request)).toBe(request);
  });

  test("does not inject without a json response_format", () => {
    const request = { response_format: { type: "text" } };

    expect(applyResponseHealing(request)).toBe(request);
  });

  test("does not inject when response_format is absent", () => {
    const request = {};

    expect(applyResponseHealing(request)).toBe(request);
  });

  test("is idempotent when the plugin is already present", () => {
    const request = {
      response_format: { type: "json_schema" },
      plugins: [healingPlugin],
    };

    expect(applyResponseHealing(request)).toBe(request);
  });

  test("does not mutate the input request", () => {
    const request = {
      response_format: { type: "json_schema" as const },
      plugins: [{ id: "web" }],
    };

    applyResponseHealing(request);

    expect(request.plugins).toEqual([{ id: "web" }]);
  });
});

describe("createResponseHealingFetch", () => {
  function recordingFetch(): {
    fetch: typeof globalThis.fetch;
    calls: Array<{ input: unknown; init: RequestInit | undefined }>;
  } {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    const fetch = ((input: unknown, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(null));
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  test("injects the plugin into a healable json body", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "20" },
      body: JSON.stringify({ response_format: { type: "json_schema" } }),
    });

    const forwarded = JSON.parse(calls[0].init?.body as string);
    expect(forwarded.plugins).toEqual([healingPlugin]);
  });

  test("drops a stale content-length after mutating the body", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      headers: { "content-length": "20" },
      body: JSON.stringify({ response_format: { type: "json_schema" } }),
    });

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.has("content-length")).toBe(false);
  });

  test("forwards streaming requests unchanged", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);
    const body = JSON.stringify({
      stream: true,
      response_format: { type: "json_schema" },
    });

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      body,
    });

    expect(calls[0].init?.body).toBe(body);
  });

  test("forwards non-json string bodies unchanged", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      body: "not json",
    });

    expect(calls[0].init?.body).toBe("not json");
  });

  test("forwards bodies without a json response_format unchanged", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);
    const body = JSON.stringify({ messages: [] });

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      body,
    });

    expect(calls[0].init?.body).toBe(body);
  });

  test("forwards non-string bodies untouched", async () => {
    const { fetch, calls } = recordingFetch();
    const healingFetch = createResponseHealingFetch(fetch);
    const body = new Uint8Array([1, 2, 3]);

    await healingFetch("https://openrouter.ai/api/v1/chat/completions", {
      body,
    });

    expect(calls[0].init?.body).toBe(body);
  });

  // Boundary test: drive the real Vercel AI SDK so we verify the actual
  // outbound request shape (string body + json_schema response_format), not a
  // synthetic body. This is the only injection point for direct OpenRouter calls.
  test("injects the plugin into a real generateObject request", async () => {
    let sentBody: string | undefined;
    const baseFetch = ((_input: unknown, init?: RequestInit) => {
      sentBody = init?.body as string;
      const completion = {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model: "openrouter/test",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({ answer: "hi" }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      return Promise.resolve(
        new Response(JSON.stringify(completion), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;

    const model = createOpenAI({
      apiKey: "test-key",
      fetch: createResponseHealingFetch(baseFetch),
    }).chat("openrouter/test");

    await generateObject({
      model,
      schema: z.object({ answer: z.string() }),
      prompt: "say hi",
    });

    const sent = JSON.parse(sentBody as string);
    expect(sent.response_format?.type).toBe("json_schema");
    expect(sent.plugins).toEqual([healingPlugin]);
  });
});
