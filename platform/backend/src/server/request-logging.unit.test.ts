import { Writable } from "node:stream";
import Fastify, { type FastifyBaseLogger, LogController } from "fastify";
import pino from "pino";
import { expect, test } from "vitest";
import { registerRequestLogging } from "./request-logging";

test("successful requests log at debug and failed requests also log at info", async () => {
  const { app, logs } = makeApp();
  app.get("/api/ok", async () => ({ ok: true }));
  app.get("/api/missing", async (_request, reply) =>
    reply.status(404).send({ error: "not found" }),
  );
  app.get("/api/broken", async () => {
    throw new Error("boom");
  });
  try {
    await app.inject({ method: "GET", url: "/api/ok" });
    await app.inject({ method: "GET", url: "/api/missing" });
    await app.inject({ method: "GET", url: "/api/broken" });

    expect(accessLogs(logs())).toEqual([
      { msg: "incoming request", url: "/api/ok", level: DEBUG },
      { msg: "request completed", url: "/api/ok", level: DEBUG },
      { msg: "incoming request", url: "/api/missing", level: DEBUG },
      { msg: "request completed", url: "/api/missing", level: INFO },
      { msg: "incoming request", url: "/api/broken", level: DEBUG },
      { msg: "request completed", url: "/api/broken", level: INFO },
    ]);
  } finally {
    await app.close();
  }
});

test("an unauthenticated request stays at debug", async () => {
  const { app, logs } = makeApp();
  app.get("/api/private", async (_request, reply) =>
    reply.status(401).send({ error: "Unauthenticated" }),
  );
  try {
    await app.inject({ method: "GET", url: "/api/private" });

    expect(accessLogs(logs())).toEqual([
      { msg: "incoming request", url: "/api/private", level: DEBUG },
      { msg: "request completed", url: "/api/private", level: DEBUG },
    ]);
  } finally {
    await app.close();
  }
});

test("health checks and token-bearing paths are never access-logged", async () => {
  const { app, logs } = makeApp();
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/skills/m/:token", async (_request, reply) =>
    reply.status(404).send(),
  );
  try {
    await app.inject({ method: "GET", url: "/health" });
    await app.inject({ method: "GET", url: "/skills/m/secret-share-token" });

    expect(accessLogs(logs())).toEqual([]);
    expect(JSON.stringify(logs())).not.toContain("secret-share-token");
  } finally {
    await app.close();
  }
});

// ===================================================================
// Helpers
// ===================================================================

const DEBUG = 20;
const INFO = 30;

function makeApp() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(...chunk.toString().split("\n").filter(Boolean));
      callback();
    },
  });
  const logger: FastifyBaseLogger = pino({ level: "debug" }, stream);
  const app = Fastify({
    loggerInstance: logger,
    logController: new LogController({ disableRequestLogging: true }),
  });
  registerRequestLogging(app);
  return {
    app,
    logs: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function accessLogs(logs: Record<string, unknown>[]) {
  return logs
    .filter(
      (log) =>
        log.msg === "incoming request" || log.msg === "request completed",
    )
    .map(({ msg, url, level }) => ({ msg, url, level }));
}
