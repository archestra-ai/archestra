import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { registerLlmProxyDenialLog } from "./llm-proxy-denial";

let exporter: InMemoryLogRecordExporter;
let provider: LoggerProvider;
beforeEach(() => {
  logs.disable();
  exporter = new InMemoryLogRecordExporter();
  provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter })],
  });
  logs.setGlobalLoggerProvider(provider);
});
afterEach(async () => {
  await provider.shutdown();
  logs.disable();
});

test("records pre-handler authentication and malformed JSON denials without secrets", async () => {
  const app = Fastify();
  registerLlmProxyDenialLog(app);
  app.post("/v1/openai/:agentId/chat/completions", {
    preHandler: async (request, reply) => {
      if (request.headers.authorization === "Bearer forbidden")
        return reply.code(403).send({ error: "forbidden" });
      if (request.headers.authorization !== "Bearer valid")
        return reply.code(401).send({ error: "invalid credential" });
    },
    handler: async () => ({ ok: true }),
  });

  const denied = await app.inject({
    method: "POST",
    url: "/v1/openai/secret-agent/chat/completions?token=secret-query",
    headers: { authorization: "Bearer secret-credential" },
    payload: {},
  });
  expect(denied.statusCode).toBe(401);
  const malformed = await app.inject({
    method: "POST",
    url: "/v1/openai/secret-agent/chat/completions",
    headers: { "content-type": "application/json" },
    payload: "{not-json",
  });
  expect(malformed.statusCode).toBe(400);
  const forbidden = await app.inject({
    method: "POST",
    url: "/v1/openai/secret-agent/chat/completions",
    headers: { authorization: "Bearer forbidden" },
    payload: {},
  });
  expect(forbidden.statusCode).toBe(403);

  const records = exporter.getFinishedLogRecords();
  expect(records.map((record) => record.eventName)).toEqual([
    "archestra.llm_proxy.rejected",
    "archestra.llm_proxy.rejected",
    "archestra.llm_proxy.rejected",
  ]);
  expect(records.map((record) => record.attributes)).toEqual([
    expect.objectContaining({
      "archestra.proxy.denial_kind": "authentication",
      "http.route": "/v1/openai/:agentId/chat/completions",
      "http.response.status_code": 401,
    }),
    expect.objectContaining({
      "archestra.proxy.denial_kind": "validation",
      "http.response.status_code": 400,
    }),
    expect.objectContaining({
      "archestra.proxy.denial_kind": "authorization",
      "http.response.status_code": 403,
    }),
  ]);
  expect(JSON.stringify(records)).not.toMatch(
    /secret-agent|secret-query|secret-credential/,
  );
  await app.close();
});

test("excludes handler responses and unrelated routes", async () => {
  const app = Fastify();
  registerLlmProxyDenialLog(app);
  app.post("/v1/openai/:agentId/chat/completions", async (_request, reply) => {
    return reply.code(400).send({ error: "bad request" });
  });
  app.post("/api/other", async (_request, reply) =>
    reply.code(401).send({ error: "unauthorized" }),
  );

  await app.inject({ method: "POST", url: "/v1/openai/id/chat/completions" });
  await app.inject({ method: "POST", url: "/api/other" });
  expect(exporter.getFinishedLogRecords()).toHaveLength(0);
  await app.close();
});
