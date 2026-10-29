import { setImmediate } from "node:timers/promises";
import fastifyHttpProxy from "@fastify/http-proxy";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, test } from "vitest";
import { trackBackgroundWork } from "@/utils/background-work";
import { registerLlmProxyDrain } from "./llm-proxy-drain";

const apps: FastifyInstance[] = [];
const releases: (() => void)[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const app of apps.splice(0)) {
    app.server.closeAllConnections();
    await app.close();
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
  expect((await fetch(`${url}/v1/mcp/test`)).status).toBe(200);
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
