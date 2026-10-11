import { request as httpRequest } from "node:http";
import { describe, expect, test } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { classifyErrorForTracking } from "@/observability/error-tracking-policy";

describe("incoming request disconnects", () => {
  test("does not report a client closing an incomplete request as a database outage", async () => {
    const app = createFastifyInstance();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveCaptured!: (error: unknown) => void;
    const captured = new Promise<unknown>((resolve) => {
      resolveCaptured = resolve;
    });
    app.addHook("onRequest", (request, _reply, done) => {
      request.raw.once("error", resolveCaptured);
      resolveStarted();
      done();
    });
    app.post("/upload", async () => ({ ok: true }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = httpRequest(`${address}/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "100",
      },
    });
    client.on("error", () => {});
    try {
      client.write("{");
      await started;
      client.destroy();
      const error = await captured;
      expect(error).toHaveProperty("code", "ECONNRESET");
      expect(classifyErrorForTracking(error)).toEqual({ report: false });
      // A separate connection failure is still an availability incident,
      // even when it carries the same errno as the aborted HTTP request.
      expect(
        classifyErrorForTracking(
          Object.assign(new Error("database connection reset"), {
            code: "ECONNRESET",
          }),
        ),
      ).toMatchObject({
        report: true,
        fingerprint: ["db-transient", "ECONNRESET"],
      });
    } finally {
      client.destroy();
      await app.close();
    }
  });
});
