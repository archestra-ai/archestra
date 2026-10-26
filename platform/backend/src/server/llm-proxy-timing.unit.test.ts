import { performance } from "node:perf_hooks";
import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { llmProxyTiming } from "./llm-proxy-timing";

afterEach(() => vi.restoreAllMocks());

test("server timing includes auth, persistence and serialization but excludes upstream calls from overhead", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const app = Fastify();
  // Earlier onSend hooks model serialization/post-processing before our boundary.
  app.addHook("onSend", (_request, _reply, _payload, done) => {
    clock += 3;
    done();
  });
  llmProxyTiming.register(app);
  app.addHook("preHandler", (_request, _reply, done) => {
    clock += 5;
    done();
  });
  app.post("/v1/test", async (_request, reply) => {
    // Multiple attempts are timed individually; retry backoff stays overhead.
    await expect(
      llmProxyTiming.upstream(reply, async () => {
        clock += 10;
        throw new Error("retry");
      }),
    ).rejects.toThrow("retry");
    clock += 2;
    await llmProxyTiming.upstream(reply, async () => {
      clock += 30;
    });
    clock += 8;
    return { ok: true };
  });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/test" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["server-timing"]).toBe(
      "archestra_gateway;dur=58.000, archestra_upstream;dur=40.000, archestra_overhead;dur=18.000",
    );
  } finally {
    await app.close();
  }
});

test("unsupported streams, errors, non-proxy routes and overlapping calls never advertise complete gateway timing", async () => {
  const app = Fastify();
  llmProxyTiming.register(app);
  app.post("/v1/stream", async () => "stream");
  app.post("/other", async (_request, reply) =>
    llmProxyTiming.upstream(reply, async () => "other"),
  );
  app.post("/v1/error", async (_request, reply) =>
    llmProxyTiming.upstream(reply, async () => {
      throw new Error("upstream failure");
    }),
  );
  app.post("/v1/concurrent", async (_request, reply) => {
    await Promise.all([
      llmProxyTiming.upstream(
        reply,
        async () => new Promise((resolve) => setImmediate(resolve)),
      ),
      llmProxyTiming.upstream(reply, async () => "second"),
    ]);
    return "done";
  });
  try {
    for (const url of ["/v1/stream", "/other", "/v1/error", "/v1/concurrent"]) {
      const response = await app.inject({ method: "POST", url });
      expect(response.headers["server-timing"]).toBeUndefined();
      expect(response.statusCode).toBe(url === "/v1/error" ? 500 : 200);
    }
  } finally {
    await app.close();
  }
});

test("a hijacked response carries timing for upstream calls made while it is handled", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const app = Fastify();
  llmProxyTiming.register(app);
  app.post("/v1/hijacked", async (_request, reply) => {
    reply.hijack();
    await llmProxyTiming.hijacked(reply, async () => {
      clock += 4;
      // The upstream call is made deep in the handler, without the reply.
      await new Promise((resolve) => setImmediate(resolve));
      await llmProxyTiming.hijackedUpstream(async () => {
        clock += 20;
      });
      clock += 6;
      reply.raw
        .writeHead(200, { "content-type": "application/json" })
        .end("{}");
    });
  });
  app.post("/v1/hijacked-error", async (_request, reply) => {
    reply.hijack();
    await llmProxyTiming.hijacked(reply, async () => {
      await llmProxyTiming.hijackedUpstream(async () => {});
      reply.raw.writeHead(500).end();
    });
  });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/hijacked" });
    expect(response.headers["content-type"]).toBe("application/json");
    expect(response.headers["server-timing"]).toBe(
      "archestra_gateway;dur=30.000, archestra_upstream;dur=20.000, archestra_overhead;dur=10.000",
    );
    const failed = await app.inject({
      method: "POST",
      url: "/v1/hijacked-error",
    });
    expect(failed.headers["server-timing"]).toBeUndefined();
    // Outside a hijacked response the call simply runs.
    expect(await llmProxyTiming.hijackedUpstream(async () => "ran")).toBe(
      "ran",
    );
  } finally {
    await app.close();
  }
});
