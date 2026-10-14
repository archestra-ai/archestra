import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import healthRoutes from "@/routes/health";
import { createFastifyInstance } from "@/server";
import { beginLlmProxyDrain } from "./llm-proxy-drain";

test("production hooks preserve a nested proxy stream and return readiness 503", async () => {
  const app = createFastifyInstance();
  let finish = () => {};
  const finishStream = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let persisted = false;
  let dependencyClosed = false;
  app.addHook("onClose", async () => {
    dependencyClosed = true;
  });
  await app.register(healthRoutes);
  await app.register(async (routes) => {
    routes.get("/v1/openai/stream", async (_request, reply) => {
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.write("data: first\n\n");
      await finishStream;
      reply.raw.end("data: done\n\n");
      await setImmediate();
      expect(dependencyClosed).toBe(false);
      persisted = true;
    });
  });
  try {
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${url}/v1/openai/stream`);
    const body = response.text();
    beginLlmProxyDrain(app);
    const readiness = await fetch(`${url}/ready`);
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      error: { message: "Server is shutting down" },
    });
    const rejected = await fetch(`${url}/v1/openai/stream`);
    expect(rejected.status).toBe(503);
    const close = app.close();
    finish();
    expect(await body).toBe("data: first\n\ndata: done\n\n");
    await close;
    expect(persisted).toBe(true);
    expect(dependencyClosed).toBe(true);
  } finally {
    finish();
    app.server.closeAllConnections();
    await app.close();
  }
});
