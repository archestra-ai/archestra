import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { llmUpstreamFetch } from "./llm-upstream-fetch";

/** A real HTTP upstream: the transport is exercised over sockets. */
let server: Server;
let base: string;
const received: {
  method?: string;
  headers: IncomingMessage["headers"];
  body: string;
}[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ method: request.method, headers: request.headers, body });
    const url = new URL(request.url ?? "/", "http://upstream");
    switch (url.pathname) {
      case "/json":
        response.writeHead(200, {
          "content-type": "application/json",
          "x-request-id": "req-1",
        });
        response.end(JSON.stringify({ echoed: body }));
        return;
      case "/gzip":
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(zlib.gzipSync(JSON.stringify({ ok: true })));
        return;
      case "/sse":
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: one\n\n");
        setTimeout(() => response.end("data: two\n\n"), 200);
        return;
      case "/redirect":
        response.writeHead(307, { location: "/json" });
        response.end();
        return;
      case "/empty":
        response.writeHead(204);
        response.end();
        return;
      case "/error":
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      case "/hang":
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe("llmUpstreamFetch", () => {
  test("sends the request and returns the response like fetch", async () => {
    const response = await llmUpstreamFetch(
      `${base}/json`,
      {
        method: "POST",
        headers: new Headers({ authorization: "Bearer sk-test" }),
        body: '{"model":"m"}',
      },
      undefined,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(await response.json()).toEqual({ echoed: '{"model":"m"}' });
    const request = received.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe("Bearer sk-test");
  });

  test("decodes a compressed body", async () => {
    const response = await llmUpstreamFetch(`${base}/gzip`, {}, undefined);

    expect(await response.json()).toEqual({ ok: true });
  });

  test("streams an event stream as it arrives", async () => {
    const response = await llmUpstreamFetch(`${base}/sse`, {}, undefined);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: one\n\n");
    let rest = "";
    for (let next = await reader.read(); !next.done; next = await reader.read())
      rest += new TextDecoder().decode(next.value);
    expect(rest).toBe("data: two\n\n");
  });

  test("follows a redirect with the original body", async () => {
    const response = await llmUpstreamFetch(
      `${base}/redirect`,
      { method: "POST", body: "payload" },
      undefined,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ echoed: "payload" });
  });

  test("returns error responses without throwing", async () => {
    const response = await llmUpstreamFetch(`${base}/error`, {}, undefined);

    expect(response.ok).toBe(false);
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { message: "slow down" } });
  });

  test("returns a null body for a no-content status", async () => {
    const response = await llmUpstreamFetch(`${base}/empty`, {}, undefined);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  test("rejects with the abort reason when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = llmUpstreamFetch(
      `${base}/hang`,
      { signal: controller.signal },
      undefined,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("rejects a network failure as fetch does", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));

    const failure = await llmUpstreamFetch(
      `http://127.0.0.1:${port}/`,
      {},
      undefined,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toBe("fetch failed");
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe(
      "ECONNREFUSED",
    );
  });

  test("sends a form body through fetch", async () => {
    const form = new FormData();
    form.set("purpose", "batch");

    const response = await llmUpstreamFetch(
      `${base}/json`,
      { method: "POST", body: form },
      undefined,
    );

    expect(response.status).toBe(200);
    expect(received.at(-1)?.headers["content-type"]).toMatch(
      /^multipart\/form-data/,
    );
  });

  test("a fetch installed after startup handles the call", async () => {
    const replaced = vi.fn(async () => Response.json({ via: "replaced" }));
    vi.stubGlobal("fetch", replaced);
    try {
      const response = await llmUpstreamFetch(`${base}/json`, {}, undefined);

      expect(await response.json()).toEqual({ via: "replaced" });
      expect(replaced).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
