import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createProxyPreHandler } from "./proxy-prehandler";

const TEST_UUID = "44f56e01-7167-42c1-88ee-64b566fbc34d";

describe("createProxyPreHandler", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/v1/models", async () => ({
      object: "list",
      data: [{ id: "gpt-4", object: "model" }],
    }));

    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      object: "model",
    }));

    mockUpstream.get("/models", async () => ({
      object: "list",
      data: [{ id: "test-model", object: "model" }],
    }));

    // Registered for GET-passthrough test (proxy only skips POST)
    mockUpstream.get("/chat/completions", async () => ({
      result: "proxied",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;
  });

  afterEach(async () => {
    await app?.close();
    await mockUpstream?.close();
  });

  async function setupProxy(params: {
    apiPrefix: string;
    endpointSuffix: string;
    rewritePrefix?: string;
    providerName: string;
    skipErrorResponse?: Record<string, unknown>;
  }) {
    const {
      apiPrefix,
      endpointSuffix,
      rewritePrefix,
      providerName,
      skipErrorResponse,
    } = params;
    const upstream = `http://localhost:${upstreamPort}`;

    app = Fastify();

    const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;

    await app.register(fastifyHttpProxy, {
      upstream,
      prefix: apiPrefix,
      rewritePrefix: rewritePrefix ?? "",
      preHandler: createProxyPreHandler({
        apiPrefix,
        endpointSuffix,
        upstream,
        providerName,
        rewritePrefix,
        skipErrorResponse,
      }),
    });

    return app;
  }

  describe("endpoint skipping", () => {
    test("returns 400 for POST to the custom-handled endpoint suffix", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/openai/chat/completions",
        headers: { "content-type": "application/json" },
        payload: { model: "gpt-4", messages: [] },
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error.type).toBe("invalid_request_error");
    });

    test("returns 400 for POST to endpoint suffix with UUID prefix", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${TEST_UUID}/chat/completions`,
        headers: { "content-type": "application/json" },
        payload: { model: "gpt-4", messages: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    test("does not skip GET requests to the endpoint suffix", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/openai/chat/completions",
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body).result).toBe("proxied");
    });

    test("does not skip POST to sub-paths of the endpoint suffix", async () => {
      // Need a fresh upstream with the count_tokens route
      await mockUpstream.close();
      mockUpstream = Fastify();
      mockUpstream.post("/v1/messages/count_tokens", async () => ({
        result: "counted",
      }));
      await mockUpstream.listen({ port: 0 });
      const address = mockUpstream.server.address();
      upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

      await setupProxy({
        apiPrefix: "/v1/anthropic",
        endpointSuffix: "/messages",
        rewritePrefix: "/v1",
        providerName: "Anthropic",
      });

      // /messages/count_tokens should NOT match endsWith("/messages")
      const response = await app.inject({
        method: "POST",
        url: "/v1/anthropic/messages/count_tokens",
        headers: { "content-type": "application/json" },
        payload: {},
      });

      // Should be proxied through (not 400)
      expect(response.statusCode).not.toBe(400);
    });

    test("uses custom skipErrorResponse when provided", async () => {
      const customError = {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Use the dedicated endpoint",
        },
      };

      await setupProxy({
        apiPrefix: "/v1/anthropic",
        endpointSuffix: "/messages",
        providerName: "Anthropic",
        skipErrorResponse: customError,
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/anthropic/messages",
        headers: { "content-type": "application/json" },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("invalid_request_error");
    });
  });

  describe("UUID stripping", () => {
    test("strips UUID and proxies correctly", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        rewritePrefix: "/v1",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/openai/${TEST_UUID}/models`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe("list");
    });

    test("strips UUID and proxies nested paths", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        rewritePrefix: "/v1",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/openai/${TEST_UUID}/models/gpt-4`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.id).toBe("gpt-4");
    });

    test("proxies without UUID normally", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        rewritePrefix: "/v1",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/openai/models",
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe("list");
    });

    test("does not strip non-UUID segments", async () => {
      await setupProxy({
        apiPrefix: "/v1/openai",
        endpointSuffix: "/chat/completions",
        rewritePrefix: "/v1",
        providerName: "OpenAI",
      });

      const response = await app.inject({
        method: "GET",
        url: "/v1/openai/not-a-uuid/models",
      });

      // Proxied as-is to upstream, which won't have this path
      expect(response.statusCode).toBe(404);
    });
  });

  describe("works with different provider configs", () => {
    test("Cohere-style /chat suffix skips POST", async () => {
      await setupProxy({
        apiPrefix: "/v1/cohere",
        endpointSuffix: "/chat",
        providerName: "Cohere",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/cohere/chat",
        headers: { "content-type": "application/json" },
        payload: { message: "hi" },
      });

      expect(response.statusCode).toBe(400);
    });

    test("Anthropic-style /messages suffix skips POST", async () => {
      await setupProxy({
        apiPrefix: "/v1/anthropic",
        endpointSuffix: "/messages",
        providerName: "Anthropic",
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/anthropic/messages",
        headers: { "content-type": "application/json" },
        payload: { model: "claude-3", messages: [] },
      });

      expect(response.statusCode).toBe(400);
    });

    test("UUID stripping works with empty rewritePrefix", async () => {
      await setupProxy({
        apiPrefix: "/v1/cerebras",
        endpointSuffix: "/chat/completions",
        rewritePrefix: "",
        providerName: "Cerebras",
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/cerebras/${TEST_UUID}/models`,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe("list");
    });
  });
});
