import { describe, expect, test } from "vitest";
import { boundedMediaFetch } from "./bounded-media-response";

describe("bounded SDK media responses", () => {
  test("preserves arbitrary bytes and provider status after bounded buffering", async () => {
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    const response = await boundedMediaFetch(
      async () =>
        new Response(bytes, {
          status: 201,
          headers: { "content-type": "application/octet-stream" },
        }),
      5,
    )("http://fixture.example");
    expect(response.status).toBe(201);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  test("rejects an oversized declared body and cancels it without reading", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      cancel: () => {
        cancelled = true;
      },
    });
    const response = await boundedMediaFetch(
      async () => new Response(body, { headers: { "content-length": "6" } }),
      5,
    )("http://fixture.example");
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
    expect(await response.text()).toContain("exceeds the proxy body limit");
  });

  test("rejects chunked overflow and stops reading the stream", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(3));
        controller.enqueue(new Uint8Array(3));
      },
      cancel: () => {
        cancelled = true;
      },
    });
    const response = await boundedMediaFetch(
      async () => new Response(body),
      5,
    )("http://fixture.example");
    expect(response.status).toBe(502);
    expect(cancelled).toBe(true);
  });

  test("preserves bounded upstream HTTP errors so SDKs cannot treat overflow as a connection retry", async () => {
    const response = await boundedMediaFetch(
      async () =>
        Response.json({ error: { message: "quota" } }, { status: 429 }),
      1000,
    )("http://fixture.example");
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "quota" } });
  });
});
