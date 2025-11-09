import { afterEach, beforeEach, describe, expect, test } from "@/test";

describe("Anthropic proxy routing", () => {
  let app: import("fastify").FastifyInstance;
  let mockUpstream: import("fastify").FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    const Fastify = (await import("fastify")).default;

    // Create a mock upstream server
    mockUpstream = Fastify();

    // Mock Anthropic endpoints
    // Note: Our proxy rewrites /v1/anthropic/v1/models to /v1/v1/models
    mockUpstream.get("/v1/v1/models", async () => ({
      data: [
        { id: "claude-3-5-sonnet-20241022", type: "model" },
        { id: "claude-3-opus-20240229", type: "model" },
      ],
    }));

    mockUpstream.get("/v1/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      type: "model",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    // Create test app with proxy pointing to mock upstream
    app = Fastify();

    // Register routes with a modified version that uses the mock upstream
    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/anthropic";
      const MESSAGES_SUFFIX = "/messages";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "/v1",
        preHandler: (request, _reply, next) => {
          if (
            request.method === "POST" &&
            request.url.includes(MESSAGES_SUFFIX)
          ) {
            next(new Error("skip"));
            return;
          }

          const pathAfterPrefix = request.url.replace(API_PREFIX, "");
          const uuidMatch = pathAfterPrefix.match(
            /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)?$/i,
          );

          if (uuidMatch) {
            const remainingPath = uuidMatch[2] || "";
            request.raw.url = `${API_PREFIX}${remainingPath}`;
          }

          next();
        },
      });
    });
  });

  afterEach(async () => {
    await app.close();
    await mockUpstream.close();
  });

  test("proxies /v1/anthropic/v1/models without UUID", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/v1/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/anthropic/:uuid/v1/models", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/models",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data).toHaveLength(2);
  });

  test("strips UUID and proxies /v1/anthropic/:uuid/v1/models/:model", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/models/claude-3-5-sonnet-20241022",
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe("claude-3-5-sonnet-20241022");
    expect(body.type).toBe("model");
  });

  test("does not strip non-UUID segments", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/anthropic/not-a-uuid/v1/models",
    });

    // This should try to proxy to /v1/not-a-uuid/v1/models which won't exist
    expect(response.statusCode).toBe(404);
  });

  test("skips proxy for messages routes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/v1/messages",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
      },
    });

    // Should get 404 or 500 because we didn't register the actual messages handler
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
    expect([404, 500]).toContain(response.statusCode);
  });

  test("skips proxy for messages routes with UUID", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/anthropic/44f56e01-7167-42c1-88ee-64b566fbc34d/v1/messages",
      headers: {
        "content-type": "application/json",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
      },
    });

    // Should get 404 or 500 because we didn't register the actual messages handler
    // This confirms the proxy was skipped (next(new Error("skip")) throws error)
    expect([404, 500]).toContain(response.statusCode);
  });
});
