import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAi } from "@/types";
import { createOpenAiCodexClient } from "./openai-codex-client";
import { CodexResponsesGenerationError } from "./openai-codex-translator";

type Chunk = OpenAi.Types.ChatCompletionChunk;
type Completion = OpenAi.Types.ChatCompletionsResponse;
type InnerFetch = NonNullable<
  Parameters<typeof createOpenAiCodexClient>[0]["innerFetch"]
>;

const request = {
  model: "gpt-4.1",
  messages: [{ role: "user" as const, content: "Check the result" }],
};
const usage = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 5 },
  total_tokens: 17,
};

describe("Codex subscription client terminal lifecycle", () => {
  beforeEach(() => {
    // Token redemption and inference are separate fake HTTP boundaries. No
    // credential store or real provider is involved in these SDK-wrapper tests.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "synthetic-access-token",
              expires_in: 3600,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(
    (["incomplete", "filtered", "failed", "eof"] as const).flatMap((terminal) =>
      [false, true].map((stream) => ({ terminal, stream })),
    ),
  )("propagates typed $terminal through the actual SDK wrapper (stream=$stream)", async ({
    terminal,
    stream,
  }) => {
    const incomplete = terminal === "incomplete" || terminal === "filtered";
    const reason =
      terminal === "filtered" ? "content_filter" : "max_output_tokens";
    const response = {
      id: "resp_subscription_failure",
      object: "response",
      created_at: 123,
      model: request.model,
      status: terminal === "failed" ? "failed" : "incomplete",
      output: [],
      incomplete_details: incomplete ? { reason } : null,
      error:
        terminal === "failed"
          ? { code: "server_error", message: "Synthetic provider failure" }
          : null,
      usage,
    };
    const innerFetch = vi.fn(async () =>
      sseResponse([
        {
          type: "response.created",
          response: { ...response, status: "in_progress" },
        },
        { type: "response.output_text.delta", delta: "Partial result" },
        {
          type: "response.output_item.added",
          item: {
            id: "fc_held",
            type: "function_call",
            call_id: "call_held",
            name: "mutating_action",
            arguments: '{"note":"must-not-run"}',
          },
        },
        ...(terminal === "eof"
          ? []
          : [{ type: `response.${response.status}`, response }]),
      ]),
    );
    const client = clientFor(innerFetch);
    const chunks: Chunk[] = [];
    const run = async () => {
      const result = await client.chat.completions.create({
        ...request,
        stream,
      });
      if (stream) {
        for await (const chunk of result as unknown as AsyncIterable<Chunk>) {
          chunks.push(chunk);
        }
      }
      return result;
    };
    await expect(run()).rejects.toMatchObject({
      statusCode: 502,
      isIncompleteTerminal: incomplete,
      completion: {
        object: "chat.completion",
        provider_response_id: response.id,
        status: response.status,
        incomplete_details: response.incomplete_details,
        choices: [
          {
            message: { role: "assistant", content: "Partial result" },
            finish_reason: incomplete
              ? terminal === "filtered"
                ? "content_filter"
                : "length"
              : "error",
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 7,
          total_tokens: 17,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 5 },
        },
        error:
          terminal === "eof"
            ? { code: "proxy_stream_incomplete" }
            : response.error,
      },
    });
    expect(innerFetch).toHaveBeenCalledOnce();
    expect(chunks.every((chunk) => !chunk.choices[0]?.delta.tool_calls)).toBe(
      true,
    );
    expect(chunks.every((chunk) => !chunk.choices[0]?.finish_reason)).toBe(
      true,
    );
    if (stream) {
      expect(
        chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
      ).toBe("Partial result");
    }
  });

  it.each([
    false,
    true,
  ])("does not manufacture a successful terminal for an empty EOF (stream=%s)", async (stream) => {
    const innerFetch = vi.fn(async () => sseResponse([]));
    const client = clientFor(innerFetch);
    const run = async () => {
      const result = await client.chat.completions.create({
        ...request,
        stream,
      });
      if (stream) {
        for await (const _chunk of result as unknown as AsyncIterable<Chunk>) {
          // The opening role chunk is not a successful terminal.
        }
      }
    };
    await expect(run()).rejects.toMatchObject({
      isIncompleteTerminal: false,
      completion: {
        status: "incomplete",
        incomplete_details: null,
        error: { code: "proxy_stream_incomplete" },
        choices: [{ finish_reason: "error", message: { content: null } }],
      },
    });
    expect(innerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])("keeps completed text and tool-call snapshots unchanged (stream=%s)", async (stream) => {
    const call = {
      id: "fc_complete",
      type: "function_call",
      call_id: "call_complete",
      name: "public_lookup",
      arguments: '{"topic":"complete"}',
      status: "completed",
    };
    const innerFetch = vi.fn(async () =>
      sseResponse([
        { type: "response.output_text.delta", delta: "Complete result" },
        {
          type: "response.output_item.added",
          item: { ...call, arguments: "" },
        },
        {
          type: "response.completed",
          response: {
            id: "resp_subscription_complete",
            status: "completed",
            output: [call],
            usage,
          },
        },
      ]),
    );
    const result = await clientFor(innerFetch).chat.completions.create({
      ...request,
      stream,
    });
    if (stream) {
      const chunks: Chunk[] = [];
      for await (const chunk of result as unknown as AsyncIterable<Chunk>)
        chunks.push(chunk);
      expect(
        chunks.map((chunk) => chunk.choices[0]?.delta.content ?? "").join(""),
      ).toBe("Complete result");
      expect(
        chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []),
      ).toEqual([
        {
          index: 0,
          id: call.call_id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
      ]);
      expect(chunks.at(-1)).toMatchObject({
        choices: [{ finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 7 },
      });
    } else {
      expect(result as unknown as Completion).toMatchObject({
        choices: [
          {
            message: {
              content: "Complete result",
              tool_calls: [
                {
                  id: call.call_id,
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 7 },
      });
    }
    expect(innerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])("preserves HTTP transport failures without translation or retry (stream=%s)", async (stream) => {
    const innerFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Synthetic unavailable transport",
              type: "server_error",
              code: "upstream_unavailable",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const error = await clientFor(innerFetch)
      .chat.completions.create({ ...request, stream })
      .catch((failure: unknown) => failure);
    expect(error).not.toBeInstanceOf(CodexResponsesGenerationError);
    expect(error).toMatchObject({
      status: 503,
      error: {
        message: "Synthetic unavailable transport",
        code: "upstream_unavailable",
      },
    });
    expect(innerFetch).toHaveBeenCalledOnce();
  });

  it.each([
    false,
    true,
  ])("does not misclassify an interrupted body as clean EOF (stream=%s)", async (stream) => {
    const interruption = new Error("Synthetic interrupted body");
    const innerFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(interruption);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const run = async () => {
      const result = await clientFor(innerFetch).chat.completions.create({
        ...request,
        stream,
      });
      if (stream) {
        for await (const _chunk of result as unknown as AsyncIterable<Chunk>) {
          // Drain the real SDK parser until its transport error propagates.
        }
      }
    };
    const error = await run().catch((failure: unknown) => failure);
    expect(error).toBe(interruption);
    expect(error).not.toBeInstanceOf(CodexResponsesGenerationError);
    expect(innerFetch).toHaveBeenCalledOnce();
  });
});

function clientFor(innerFetch: InnerFetch) {
  return createOpenAiCodexClient({
    credential: {
      refreshToken: `synthetic-refresh-${randomUUID()}`,
      accountId: "synthetic-account",
    },
    options: { source: "api", sessionId: `synthetic-session-${randomUUID()}` },
    innerFetch,
  });
}

function sseResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}
