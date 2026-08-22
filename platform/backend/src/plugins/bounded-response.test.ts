import { describe, expect, test } from "vitest";
import { readResponseBodyWithLimit } from "./bounded-response";

describe("readResponseBodyWithLimit", () => {
  test("returns bytes when the streamed body stays within the limit", async () => {
    const bytes = await readResponseBodyWithLimit(
      new Response("plugin bytes"),
      32,
    );
    expect(bytes?.toString("utf8")).toBe("plugin bytes");
  });

  test("rejects an oversized content length before retaining the body", async () => {
    const bytes = await readResponseBodyWithLimit(
      new Response("oversized", {
        headers: { "content-length": "100" },
      }),
      8,
    );
    expect(bytes).toBeNull();
  });

  test("cancels a streamed body as soon as it crosses the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });

    const bytes = await readResponseBodyWithLimit(new Response(body), 6);

    expect(bytes).toBeNull();
    expect(cancelled).toBe(true);
  });
});
