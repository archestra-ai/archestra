import httpProxy from "@fastify/http-proxy";
import Fastify from "fastify";
import { expect, test } from "vitest";
import { createProxyPreHandler } from "../routes/proxy-prehandler";
import {
  captureClientRuntimeEvidence,
  consumeClientRuntimeEvidence,
} from "./client-runtime-evidence";

test("an early hook retains private inference evidence outside both header representations", async () => {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    captureClientRuntimeEvidence(request);
  });
  app.post("/inference", async (request) => ({
    hasEvidence: consumeClientRuntimeEvidence(request)?.serverNames,
    headers: request.headers,
    rawHeaders: request.raw.rawHeaders,
  }));
  try {
    const response = await app.inject({
      method: "POST",
      url: "/inference",
      headers: {
        "X-Archestra-Client-Runtime-Token":
          "example-private-runtime-capability",
        "X-Archestra-Mcp-Aliases": '["primary","legacy"]',
      },
    });
    expect(response.json().hasEvidence).toEqual(["primary", "legacy"]);
    expect(response.body).not.toContain("example-private-runtime-capability");
    expect(response.json().headers).not.toHaveProperty(
      "x-archestra-mcp-aliases",
    );
    expect(
      response.json().rawHeaders.map((value: string) => value.toLowerCase()),
    ).not.toContain("x-archestra-client-runtime-token");
  } finally {
    await app.close();
  }
});

test("catch-all forwarding never sends private capabilities through Node rawHeaders", async () => {
  const upstream = Fastify();
  upstream.get("/unhandled", async (request) => ({
    headers: request.headers,
    rawHeaders: request.raw.rawHeaders,
  }));
  const origin = await upstream.listen({ port: 0, host: "127.0.0.1" });
  const app = Fastify();
  // Exercise the fallback hook itself: standalone route registrations do not
  // necessarily use the production server's global onRequest hook.
  await app.register(httpProxy, {
    upstream: origin,
    prefix: "/proxy",
    rewritePrefix: "",
    preHandler: createProxyPreHandler({
      apiPrefix: "/proxy",
      endpointSuffix: "/chat/completions",
      upstream: origin,
      providerName: "Example",
    }),
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/proxy/unhandled",
      headers: {
        authorization: "Bearer example-inference-credential",
        "X-Archestra-Client-Runtime-Token":
          "example-private-runtime-capability",
        "X-Archestra-Mcp-Aliases": '["primary","legacy"]',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("example-private-runtime-capability");
    expect(response.body).not.toContain("x-archestra-mcp-aliases");
    expect(response.json().headers.authorization).toBe(
      "Bearer example-inference-credential",
    );
  } finally {
    await app.close();
    await upstream.close();
  }
});
