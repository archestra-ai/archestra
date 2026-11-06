import { APIError } from "openai";
import { Stream } from "openai/core/streaming";
import { describe, expect, test } from "vitest";
import { streamChatCompletionChunks } from "./chat-completions-stream";

describe("streamChatCompletionChunks", () => {
  test("yields the same chunks as the SDK parser however the bytes are split", async () => {
    const body = [
      ": keep-alive comment\n\n",
      'data: {"id":"a","choices":[{"delta":{"content":"héllo 👋"}}]}\r\n\r\n',
      'event: message\nid: 7\ndata: {"id":"b",\ndata: "choices":[]}\n\n',
      'data:{"id":"c","choices":[{"delta":{"content":"\\n"}}]}\r\r',
      'data: {"id":"d","choices":[],"usage":{"prompt_tokens":3}}\n\n',
      "data: [DONE]\n\n",
      'data: {"id":"after-done"}\n\n',
    ].join("");
    const bytes = new TextEncoder().encode(body);
    const expected = await collect(
      Stream.fromSSEResponse(sseResponse([bytes]), new AbortController()),
    );
    expect(expected.map((chunk) => (chunk as { id: string }).id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    for (let size = 1; size <= 9; size++) {
      const pieces: Uint8Array[] = [];
      for (let at = 0; at < bytes.length; at += size) {
        pieces.push(bytes.slice(at, at + size));
      }
      const chunks = await collect(
        await streamChatCompletionChunks(sdkRequest(sseResponse(pieces))),
      );
      expect(chunks).toEqual(expected);
    }
  });

  test("throws the provider's error when a chunk carries one", async () => {
    const stream = await streamChatCompletionChunks(
      sdkRequest(
        sseResponse([
          'data: {"id":"a","choices":[]}\n\n',
          'data: {"error":{"message":"overloaded","code":"server_busy"}}\n\n',
        ]),
      ),
    );

    const error = await collect(stream).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({ code: "server_busy" });
    expect((error as Error).message).toContain("overloaded");
  });

  test("ends quietly when the request is aborted", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (reads++ === 0) {
            controller.enqueue(
              new TextEncoder().encode('data: {"id":"a","choices":[]}\n\n'),
            );
            return;
          }
          controller.error(
            new DOMException("This operation was aborted", "AbortError"),
          );
        },
      },
      { highWaterMark: 0 },
    );

    const chunks = await collect(
      await streamChatCompletionChunks(sdkRequest(new Response(body))),
    );

    expect(chunks).toEqual([{ id: "a", choices: [] }]);
  });

  test("releases the upstream body when the reader stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"id":"a","choices":[]}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = await streamChatCompletionChunks(
      sdkRequest(new Response(body)),
    );

    for await (const _chunk of stream) break;

    expect(cancelled).toBe(true);
  });

  test("passes through chunks from a client that is not the SDK", async () => {
    async function* chunks() {
      yield { id: "a" };
    }

    let accepted = false;
    const stream = await streamChatCompletionChunks(
      Promise.resolve(chunks()),
      () => {
        accepted = true;
      },
    );

    expect(accepted).toBe(false);
    expect(await collect(stream)).toEqual([{ id: "a" }]);
    expect(accepted).toBe(false);
  });
});

function sseResponse(pieces: Array<Uint8Array | string>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(
            typeof piece === "string" ? new TextEncoder().encode(piece) : piece,
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

/** The shape of the SDK's request promise: awaitable, with the raw response. */
function sdkRequest(response: Response) {
  return Object.assign(Promise.resolve(undefined), {
    asResponse: async () => response,
  });
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
