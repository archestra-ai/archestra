import { once } from "node:events";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import fastifyHttpProxy from "@fastify/http-proxy";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test, vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import { trackBackgroundWork } from "@/utils/background-work";
import { withDrainScope } from "@/utils/drain-scope";
import {
  drainLlmProxyRequests,
  registerLlmProxyDrain,
  registerShutdownStream,
  withDrainContinuation,
} from "./llm-proxy-drain";

const apps: FastifyInstance[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
  }
});

test("an admitted socket turn finishes its gateway and nested model calls during drain", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 2000);
  const proceed = gate();
  const started = gate();
  const modelStarted = gate();
  const finishModel = gate();
  let modelCalls = 0;
  let dependencyClosed = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.post("/v1/openai/chat/completions", async (request) => {
    modelCalls++;
    expect(request.headers["x-archestra-drain-scope"]).toBeUndefined();
    modelStarted.resolve();
    await finishModel.promise;
    expect(dependencyClosed).toBe(false);
    return { answer: "completed" };
  });
  let url: string;
  app.post("/v1/mcp/agent", async () => {
    const response = await fetch(`${url}/v1/openai/chat/completions`, {
      method: "POST",
      headers: internalCallHeader(),
    });
    return { status: response.status, result: await response.json() };
  });
  url = await app.listen({ host: "127.0.0.1", port: 0 });
  let savedHeaders: Record<string, string> = {};
  const turn = withDrainScope(async () => {
    savedHeaders = internalCallHeader();
    started.resolve();
    await proceed.promise;
    return fetch(`${url}/v1/mcp/agent`, {
      method: "POST",
      headers: savedHeaders,
    });
  }).then(async (response) => {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 200,
      result: { answer: "completed" },
    });
  });
  trackBackgroundWork(turn);
  await started.promise;
  drain.beginShutdown();
  const closing = drainLlmProxyRequests(app);
  expect((await fetch(`${url}/v1/mcp/agent`, { method: "POST" })).status).toBe(
    503,
  );
  expect(
    (
      await fetch(`${url}/v1/openai/chat/completions`, {
        method: "POST",
        headers: internalCallHeader(),
      })
    ).status,
  ).toBe(503);
  proceed.resolve();
  await modelStarted.promise;
  expect(dependencyClosed).toBe(false);
  finishModel.resolve();
  await turn;
  await closing;
  // A captured proof expires when its work finishes.
  expect(
    (
      await fetch(`${url}/v1/mcp/agent`, {
        method: "POST",
        headers: savedHeaders,
      })
    ).status,
  ).toBe(503);
  expect(modelCalls).toBe(1);
});

test("an admitted HTTP handler can start its loopback model call after shutdown begins", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 2000);
  const started = gate();
  const proceed = gate();
  let url: string;
  app.post("/v1/openai/chat/completions", async () => ({ completed: true }));
  app.get("/api/run", async () => {
    started.resolve();
    await proceed.promise;
    const response = await fetch(`${url}/v1/openai/chat/completions`, {
      method: "POST",
      headers: internalCallHeader(),
    });
    return { status: response.status };
  });
  url = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = fetch(`${url}/api/run`);
  await started.promise;
  drain.beginShutdown();
  const closing = drainLlmProxyRequests(app);
  proceed.resolve();
  expect(await (await request).json()).toEqual({ status: 200 });
  await closing;
});

test("drains persistence from a loopback handler started while socket work is draining", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 2000);
  const proceed = gate();
  const persist = gate();
  let dependencyClosed = false;
  let persisted = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.post("/v1/openai/chat/completions", async (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "application/json" });
    reply.raw.end('{"completed":true}');
    await persist.promise;
    expect(dependencyClosed).toBe(false);
    persisted = true;
  });
  await app.ready();
  const turn = withDrainScope(async () => {
    await proceed.promise;
    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/chat/completions",
      headers: internalCallHeader(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ completed: true });
  });
  trackBackgroundWork(turn);
  let drained = false;
  const closing = drainLlmProxyRequests(app).then(async () => {
    drained = true;
    await app.close();
  });
  // The drain initially sees no HTTP handlers and waits on socket work.
  await setImmediate();
  proceed.resolve();
  await turn;
  await setImmediate();
  expect(persisted).toBe(false);
  expect(drained).toBe(false);
  expect(dependencyClosed).toBe(false);
  persist.resolve();
  await closing;
  expect(persisted).toBe(true);
  expect(dependencyClosed).toBe(true);
});

test("forged scopes and live scopes past the drain deadline cannot admit new calls", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 5);
  app.post("/v1/mcp/agent", async () => ({ completed: true }));
  app.post("/v1/openai/chat/completions", async () => ({ completed: true }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  drain.beginShutdown();
  for (const path of ["/v1/mcp/agent", "/v1/openai/chat/completions"]) {
    expect(
      (
        await fetch(`${url}${path}`, {
          method: "POST",
          headers: { "x-archestra-drain-scope": "forged" },
        })
      ).status,
    ).toBe(503);
  }
  await withDrainScope(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const path of ["/v1/mcp/agent", "/v1/openai/chat/completions"]) {
      expect(
        (
          await fetch(`${url}${path}`, {
            method: "POST",
            headers: internalCallHeader(),
          })
        ).status,
      ).toBe(503);
    }
  });
});

test.each([
  {
    clockShiftMs: 3_600_000,
    graceMs: 60_000,
    elapsedMs: 1,
    expectedStatus: 200,
  },
  { clockShiftMs: -3_600_000, graceMs: 5, elapsedMs: 6, expectedStatus: 503 },
])("drain admission uses elapsed time after a $clockShiftMs ms wall-clock correction", async ({
  clockShiftMs,
  graceMs,
  elapsedMs,
  expectedStatus,
}) => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, graceMs);
  const paths = ["/v1/mcp/agent", "/v1/openai/chat/completions"];
  for (const path of paths) app.post(path, async () => ({ completed: true }));
  await app.ready();
  const wallTime = Date.now();
  const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(1000);
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(wallTime);
  try {
    drain.beginShutdown();
    wallClock.mockReturnValue(wallTime + clockShiftMs);
    elapsedClock.mockReturnValue(1000 + elapsedMs);
    await withDrainScope(async () => {
      for (const path of paths) {
        const response = await app.inject({
          method: "POST",
          url: path,
          headers: internalCallHeader(),
        });
        expect(
          response.statusCode,
          "Wall-clock corrections must not move the elapsed admission deadline",
        ).toBe(expectedStatus);
      }
    });
  } finally {
    wallClock.mockRestore();
    elapsedClock.mockRestore();
  }
});

test("a backward wall-clock correction cannot extend the drain wait", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 20);
  const started = gate();
  const finish = gate();
  app.get("/v1/openai/pending", async () => {
    started.resolve();
    await finish.promise;
    return { completed: true };
  });
  await app.ready();
  const request = app.inject("/v1/openai/pending");
  await started.promise;
  const wallTime = Date.now();
  const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(1000);
  const wallClock = vi.spyOn(Date, "now").mockReturnValue(wallTime);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const scheduleTimeout = vi.spyOn(globalThis, "setTimeout");
  try {
    drain.beginShutdown();
    wallClock.mockReturnValue(wallTime - 3_600_000);
    elapsedClock.mockReturnValue(1007);
    let completed = false;
    const draining = drainLlmProxyRequests(app).then(() => {
      completed = true;
    });
    expect(scheduleTimeout).toHaveBeenCalledWith(expect.any(Function), 13);
    elapsedClock.mockReturnValue(1019);
    await vi.advanceTimersByTimeAsync(12);
    expect(completed).toBe(false);
    elapsedClock.mockReturnValue(1020);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      completed,
      "A wall-clock rollback must not extend the elapsed drain budget",
    ).toBe(true);
    await draining;
  } finally {
    scheduleTimeout.mockRestore();
    vi.useRealTimers();
    wallClock.mockRestore();
    elapsedClock.mockRestore();
    finish.resolve();
    await request;
  }
});

test("Fastify already drains an HTTP stream, but not work after raw.end", async () => {
  const app = createApp();
  const finishStream = gate();
  const persist = gate();
  const settled = gate();
  let persisted = false;
  app.get("/v1/openai/stream", async (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: first\n\n");
    await finishStream.promise;
    reply.raw.end("data: last\n\n");
    await persist.promise;
    persisted = true;
    settled.resolve();
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${url}/v1/openai/stream`, {
    headers: { Connection: "close" },
  });
  const body = response.text();
  let closed = false;
  const close = app.close().then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  finishStream.resolve();
  expect(await body).toBe("data: first\n\ndata: last\n\n");
  await close;
  expect(persisted).toBe(false);
  persist.resolve();
  await settled.promise;
});

test("drains complete SSE bytes and persistence before onClose dependencies", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 1000);
  const finishStream = gate();
  const persist = gate();
  const persistenceStarted = gate();
  const usageUpdate = gate();
  const usageStarted = gate();
  let dependencyClosed = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.get("/v1/anthropic/messages", async (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: first\n\n");
    await finishStream.promise;
    reply.raw.end("data: done\n\n");
    persistenceStarted.resolve();
    await persist.promise;
    expect(dependencyClosed).toBe(false);
    trackBackgroundWork(usageUpdate.promise);
    usageStarted.resolve();
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${url}/v1/anthropic/messages`);
  const body = response.text();
  drain.beginShutdown();
  const close = app.close();
  finishStream.resolve();
  await persistenceStarted.promise;
  expect(await body).toBe("data: first\n\ndata: done\n\n");
  await setImmediate();
  expect(dependencyClosed).toBe(false);
  persist.resolve();
  await usageStarted.promise;
  await setImmediate();
  expect(dependencyClosed).toBe(false);
  usageUpdate.resolve();
  await close;
  expect(dependencyClosed).toBe(true);
});

test("rejects new proxy work and readiness while an admitted JSON request finishes", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 1000);
  const admitted = gate();
  const finish = gate();
  let calls = 0;
  app.get("/v1/model-router/completion", async () => {
    calls++;
    admitted.resolve();
    await finish.promise;
    return { completed: true };
  });
  app.get("/ready", async () => ({ status: "ok" }));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/mcp/test", async () => ({ mcp: true }));
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const original = fetch(`${url}/v1/model-router/completion`);
  await admitted.promise;
  drain.beginShutdown();
  const rejected = await fetch(`${url}/v1/model-router/completion`);
  expect(rejected.status).toBe(503);
  expect(rejected.headers.get("connection")).toBe("close");
  expect(rejected.headers.get("retry-after")).toBe("1");
  expect((await fetch(`${url}/ready`)).status).toBe(503);
  expect((await fetch(`${url}/health`)).status).toBe(200);
  expect((await fetch(`${url}/v1/mcp/test`)).status).toBe(503);
  expect(calls).toBe(1);
  const close = app.close();
  finish.resolve();
  expect(await (await original).json()).toEqual({ completed: true });
  await close;
});

test("a disconnected client does not release a still-running handler", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  const persist = gate();
  let dependencyClosed = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.get("/v1/openai/responses", async (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: first\n\n");
    await persist.promise;
    reply.raw.end();
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = await fetch(`${url}/v1/openai/responses`, {
    signal: abort.signal,
  });
  const body = response.text().catch(() => undefined);
  const close = app.close();
  abort.abort();
  await body;
  await setImmediate();
  expect(dependencyClosed).toBe(false);
  persist.resolve();
  await close;
  expect(dependencyClosed).toBe(true);
});

test("keeps draining a raw stream after its synchronous handler returns", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  let endStream = () => {};
  app.get("/v1/openai/passthrough", (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: first\n\n");
    endStream = () => reply.raw.end("data: last\n\n");
    return reply;
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${url}/v1/openai/passthrough`);
  const body = response.text();
  let closed = false;
  const close = app.close().then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  endStream();
  expect(await body).toBe("data: first\n\ndata: last\n\n");
  await close;
});

test("preserves http-proxy's synchronous undefined return while upstream is pending", async () => {
  const upstream = createApp();
  const upstreamEntered = gate();
  const finishUpstream = gate();
  upstream.get("/delayed", async () => {
    upstreamEntered.resolve();
    await finishUpstream.promise;
    return { upstream: true };
  });
  const upstreamUrl = await upstream.listen({ host: "127.0.0.1", port: 0 });
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  await app.register(fastifyHttpProxy, {
    upstream: upstreamUrl,
    prefix: "/v1/openai",
    rewritePrefix: "",
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = fetch(`${url}/v1/openai/delayed`);
  await upstreamEntered.promise;
  let closed = false;
  const close = app.close().then(() => {
    closed = true;
  });
  await setImmediate();
  expect(closed).toBe(false);
  finishUpstream.resolve();
  expect(await (await response).text()).toBe('{"upstream":true}');
  await close;
});

test.each([
  "onRequest",
  "preHandler",
] as const)("an aborted request cannot run its handler after a delayed %s completes", async (hook) => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  const hookEntered = gate();
  const finishHook = gate();
  const hookFinished = gate();
  const responseClosed = gate();
  let dependencyClosed = false;
  let handlerCalls = 0;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.addHook(hook, async (_request, reply) => {
    reply.raw.once("close", responseClosed.resolve);
    hookEntered.resolve();
    await finishHook.promise;
    hookFinished.resolve();
  });
  app.get("/v1/openai/completion", () => {
    handlerCalls++;
    return { dependencyClosed };
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const abort = new AbortController();
  const response = fetch(`${url}/v1/openai/completion`, {
    signal: abort.signal,
  }).catch(() => undefined);
  await hookEntered.promise;
  abort.abort();
  await response;
  await responseClosed.promise;
  await app.close();
  expect(dependencyClosed).toBe(true);
  finishHook.resolve();
  await hookFinished.promise;
  await setImmediate();
  expect(handlerCalls).toBe(0);
});

test("bounds a stalled stream and closes its real socket at the deadline", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 30);
  const finish = gate();
  app.get("/v1/gemini/stream", async (_request, reply) => {
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.raw.write("data: first\n\n");
    await finish.promise;
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${url}/v1/gemini/stream`);
  const bodyFailed = response.text().then(
    () => false,
    () => true,
  );
  await app.close();
  expect(await bodyFailed).toBe(true);
  finish.resolve();
});

test("validation errors and handler failures do not leave phantom drain work", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  app.get(
    "/v1/openai/validate",
    {
      schema: { querystring: { type: "object", required: ["model"] } },
    },
    () => "ok",
  );
  app.get("/v1/openai/fail", () => {
    throw new Error("failed");
  });
  expect((await app.inject("/v1/openai/validate")).statusCode).toBe(400);
  expect((await app.inject("/v1/openai/fail")).statusCode).toBe(500);
  await app.close();
});

test("drains pending usage writes even when the last request already finished", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  const usageUpdate = gate();
  let dependencyClosed = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  app.get("/v1/openai/completion", () => {
    trackBackgroundWork(usageUpdate.promise);
    return { completed: true };
  });
  expect((await app.inject("/v1/openai/completion")).statusCode).toBe(200);
  const close = app.close();
  await setImmediate();
  expect(dependencyClosed).toBe(false);
  usageUpdate.resolve();
  await close;
  expect(dependencyClosed).toBe(true);
});

function createApp() {
  const app = Fastify();
  apps.push(app);
  return app;
}

function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  releases.push(resolve);
  return { promise, resolve };
}

test("drains mixed MCP and LLM calls while admitting only MCP replies and cancellation", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 1000);
  const entered = gate();
  const modelEntered = gate();
  const finish = gate();
  let calls = 0;
  app.post("/v1/mcp/test", async (request) => {
    const body = request.body as { method?: string };
    if (body.method === "tools/call") {
      calls++;
      entered.resolve();
      await finish.promise;
    }
    return { completed: true };
  });
  app.get("/v1/openai/completion", async () => {
    modelEntered.resolve();
    await finish.promise;
    return { completed: true };
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const post = (body: object) =>
    fetch(`${url}/v1/mcp/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const original = post({ method: "tools/call" });
  await entered.promise;
  const model = fetch(`${url}/v1/openai/completion`);
  await modelEntered.promise;
  drain.beginShutdown();
  const draining = drainLlmProxyRequests(app);
  expect((await post({ method: "tools/call" })).status).toBe(503);
  expect((await post({ method: "tools/list" })).status).toBe(503);
  expect(
    (await post({ jsonrpc: "2.0", id: "pending", result: { answer: "yes" } }))
      .status,
  ).toBe(200);
  expect(
    (
      await post({
        method: "notifications/cancelled",
        params: { requestId: 1 },
      })
    ).status,
  ).toBe(200);
  expect(calls).toBe(1);
  finish.resolve();
  expect((await original).status).toBe(200);
  expect((await model).status).toBe(200);
  await draining;
  await app.close();
});

test("ends notification streams after calls finish instead of waiting for their lifetime", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  const entered = gate(),
    finish = gate();
  app.post("/v1/mcp/test", async () => {
    entered.resolve();
    await finish.promise;
    return { completed: true };
  });
  await app.register(async (routes) => {
    routes.get("/v1/mcp/test", (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write("data: first\n\n");
      registerShutdownStream(request, reply, () =>
        reply.raw.end("data: closed\n\n"),
      );
      return reply;
    });
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${url}/v1/mcp/test`);
  const body = response.text();
  const call = fetch(`${url}/v1/mcp/test`, { method: "POST" });
  await entered.promise;
  const draining = drainLlmProxyRequests(app);
  finish.resolve();
  expect((await call).status).toBe(200);
  await draining;
  expect(await body).toBe("data: first\n\ndata: closed\n\n");
  await app.close();
});

test("preserves both admitted pipelined responses on one socket", async () => {
  const app = createApp();
  registerLlmProxyDrain(app, 1000);
  const firstEntered = gate(),
    secondEntered = gate(),
    first = gate(),
    second = gate();
  app.get("/v1/openai/first", async () => {
    firstEntered.resolve();
    await first.promise;
    return { first: true };
  });
  app.get("/v1/openai/second", async () => {
    secondEntered.resolve();
    await second.promise;
    return { second: true };
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const socket = createConnection({ host: "127.0.0.1", port: address.port });
  let body = "";
  socket.on("data", (chunk) => (body += chunk.toString()));
  try {
    await once(socket, "connect");
    const ended = once(socket, "end");
    socket.write(
      "GET /v1/openai/first HTTP/1.1\r\nHost: localhost\r\n\r\nGET /v1/openai/second HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    const draining = drainLlmProxyRequests(app);
    first.resolve();
    await setImmediate();
    expect(socket.destroyed).toBe(false);
    second.resolve();
    await draining;
    await ended;
    expect(body.match(/HTTP\/1.1 200/g)).toHaveLength(2);
    expect(body).toContain('{"first":true}');
    expect(body).toContain('{"second":true}');
  } finally {
    first.resolve();
    second.resolve();
    socket.destroy();
    await app.close();
  }
});

test("admits an acknowledged legacy message's one-time loopback hop and rejects forged tokens", async () => {
  const app = createApp();
  const drain = registerLlmProxyDrain(app, 1000);
  const replay = gate(),
    replayed = gate();
  let url = "",
    token = "";
  let status = 0;
  app.post("/v1/mcp/test", async () => ({ completed: true }));
  app.post("/api/legacy-message", async (request) => {
    trackBackgroundWork(
      withDrainContinuation(request, async (admittedToken) => {
        token = admittedToken ?? "";
        await replay.promise;
        status = (
          await fetch(`${url}/v1/mcp/test`, {
            method: "POST",
            headers: { "x-archestra-drain-continuation": token },
          })
        ).status;
        replayed.resolve();
      }),
    );
    return { accepted: true };
  });
  url = await app.listen({ host: "127.0.0.1", port: 0 });
  expect(
    (await fetch(`${url}/api/legacy-message`, { method: "POST" })).status,
  ).toBe(200);
  drain.beginShutdown();
  const draining = drainLlmProxyRequests(app);
  expect(
    (
      await fetch(`${url}/v1/mcp/test`, {
        method: "POST",
        headers: { "x-archestra-drain-continuation": "forged" },
      })
    ).status,
  ).toBe(503);
  replay.resolve();
  await replayed.promise;
  expect(status).toBe(200);
  await draining;
  expect(
    (
      await fetch(`${url}/v1/mcp/test`, {
        method: "POST",
        headers: { "x-archestra-drain-continuation": token },
      })
    ).status,
  ).toBe(503);
  await app.close();
});
