/**
 * Anthropic Proxy Tests
 *
 * Tests for the unified Anthropic proxy routes covering:
 * - Cost tracking in database
 * - Streaming mode and interaction recording
 * - Interrupted stream handling
 * - Tool call accumulation (no [object Object] bug)
 * - HTTP proxy routing (UUID stripping)
 *
 * Current behavior notes:
 * - Interrupted streams may not record interactions before usage data arrives.
 * - Streaming headers are set via reply.header(), while the body is written
 *   directly through reply.raw.write().
 */

import {
  CLAUDE_CLIENT_ID,
  CLAUDE_METADATA_SESSION_SOURCE,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import logger from "@/logging";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createAnthropicTestClient } from "@/test/llm-provider-stubs";
import { anthropicAdapterFactory } from "../adapters";
import anthropicProxyRoutes from "./anthropic";

vi.mock("@/logging", () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  },
}));

function findAnthropicRequestLog(message: string) {
  return vi
    .mocked(logger.info)
    .mock.calls.find((call) => call[1] === message)?.[0] as
    | {
        headers?: Record<string, unknown>;
      }
    | undefined;
}

describe("Anthropic request logging", () => {
  beforeEach(() => {
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("summarizes default-agent headers without logging secret values", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    try {
      await app.register(anthropicProxyRoutes);
      vi.mocked(logger.info).mockClear();

      await app.inject({
        method: "POST",
        url: "/v1/anthropic/v1/messages",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer leaked-authorization-token",
          "anthropic-version": "2023-06-01",
          "x-api-key": "leaked-x-api-key",
        },
        payload: {
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 128,
        },
      });

      const requestLog = findAnthropicRequestLog(
        "[UnifiedProxy] Handling Anthropic request (default agent)",
      );

      expect(requestLog).toBeDefined();
      expect(JSON.stringify(requestLog)).not.toContain(
        "leaked-authorization-token",
      );
      expect(JSON.stringify(requestLog)).not.toContain("leaked-x-api-key");
      expect(requestLog?.headers).toEqual(
        expect.objectContaining({
          contentType: "application/json",
          anthropicVersion: "2023-06-01",
          hasAuthorization: true,
          hasXApiKey: true,
        }),
      );
    } finally {
      await app.close();
    }
  });

  test("summarizes agent headers without logging secret values", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    try {
      await app.register(anthropicProxyRoutes);
      vi.mocked(logger.info).mockClear();

      const agent = await makeAgent({ name: "Request Logging Agent" });

      await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer leaked-agent-authorization-token",
          "anthropic-version": "2023-06-01",
          "x-api-key": "leaked-agent-x-api-key",
        },
        payload: {
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 128,
        },
      });

      const requestLog = findAnthropicRequestLog(
        "[UnifiedProxy] Handling Anthropic request (with agent)",
      );

      expect(requestLog).toBeDefined();
      expect(JSON.stringify(requestLog)).not.toContain(
        "leaked-agent-authorization-token",
      );
      expect(JSON.stringify(requestLog)).not.toContain(
        "leaked-agent-x-api-key",
      );
      expect(requestLog?.headers).toEqual(
        expect.objectContaining({
          contentType: "application/json",
          anthropicVersion: "2023-06-01",
          hasAuthorization: true,
          hasXApiKey: true,
        }),
      );
    } finally {
      await app.close();
    }
  });
});

describe("Anthropic anthropic-beta forwarding", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Drive a real /messages request and return the headers the handler actually
  // hands the upstream client (the strip/forward decision's observable effect).
  async function forwardedHeaders(agentId: string, model: string) {
    let captured: Record<string, string> | undefined;
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(((
      _apiKey: string | undefined,
      options: unknown,
    ) => {
      captured = (options as { defaultHeaders?: Record<string, string> })
        ?.defaultHeaders;
      return createAnthropicTestClient() as never;
    }) as never);

    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    try {
      await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agentId}/v1/messages`,
        remoteAddress: "127.0.0.1",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
          "x-api-key": "test-anthropic-key",
          // Loopback-only override that marks the upstream as a custom base URL.
          "x-archestra-provider-base-url": "http://localhost:9/v1",
        },
        payload: {
          model,
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 128,
        },
      });
    } finally {
      await app.close();
    }
    return captured;
  }

  test("strips anthropic-beta for a non-Claude model on a custom base URL", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Beta Strip Agent" });
    const headers = await forwardedHeaders(agent.id, "kimi-k2");
    expect(headers?.["anthropic-beta"]).toBeUndefined();
  });

  test("forwards anthropic-beta for a Claude model on a custom base URL", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Beta Forward Agent" });
    const headers = await forwardedHeaders(agent.id, "claude-opus-4-20250514");
    expect(headers?.["anthropic-beta"]).toBe("pdfs-2024-09-25");
  });
});

describe("Anthropic cost tracking", () => {
  beforeEach(() => {
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("stores cost and baselineCost in interaction", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Cost Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
      },
    });

    expect(response.statusCode).toBe(200);

    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBeGreaterThan(0);

    const interaction = interactions[interactions.length - 1];
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });
});

describe("Anthropic streaming mode", () => {
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };

  beforeEach(() => {
    anthropicStubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("streaming mode completes normally and records interaction", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Streaming Agent" });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_stop");

    await new Promise((resolve) => setTimeout(resolve, 100));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("anthropic:messages");
    expect(interaction.model).toBe("claude-opus-4-20250514");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10);
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
    expect(typeof interaction.cost).toBe("string");
    expect(typeof interaction.baselineCost).toBe("string");
  });

  test("streaming mode interrupted still records interaction", {
    timeout: 10000,
  }, async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Configure stub to interrupt at chunk 3.
    anthropicStubOptions.interruptAtChunk = 3;

    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({
      name: "Test Interrupted Streaming Agent",
    });

    const { InteractionModel } = await import("@/models");

    const initialInteractions =
      await InteractionModel.getAllInteractionsForProfile(agent.id);
    const initialCount = initialInteractions.length;

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions.length).toBe(initialCount + 1);

    const interaction = interactions[interactions.length - 1];

    expect(interaction.type).toBe("anthropic:messages");
    expect(interaction.model).toBe("claude-opus-4-20250514");
    expect(interaction.inputTokens).toBe(12);
    expect(interaction.outputTokens).toBe(10); // Usage from message_start event
    expect(interaction.cost).toBeTruthy();
    expect(interaction.baselineCost).toBeTruthy();
  });
});

describe("Anthropic virtual key auth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("resolves virtual keys passed via authorization header", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    let capturedApiKey: string | undefined;
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      (apiKey) => {
        capturedApiKey = apiKey;
        return createAnthropicTestClient() as never;
      },
    );

    try {
      await app.register(anthropicProxyRoutes);

      const organization = await makeOrganization();
      const secret = await makeSecret({
        secret: { apiKey: "sk-anthropic-parent-key" },
      });
      const chatApiKey = await makeLlmProviderApiKey(
        organization.id,
        secret.id,
        {
          provider: "anthropic",
        },
      );
      const {
        virtualKey: { id: virtualKeyId },
        value,
      } = await VirtualApiKeyModel.create({
        providerApiKeys: [
          { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
        ],
        name: "anthropic-auth-header-vk",
      });

      const agent = await makeAgent({
        organizationId: organization.id,
        name: "Anthropic Virtual Key Agent",
      });

      const before = await VirtualApiKeyModel.findById(virtualKeyId);
      expect(before?.lastUsedAt).toBeNull();

      const response = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${value}`,
          "anthropic-version": "2023-06-01",
        },
        payload: {
          model: "claude-opus-4-20250514",
          messages: [{ role: "user", content: "Hello!" }],
          max_tokens: 128,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(capturedApiKey).toBe("sk-anthropic-parent-key");

      const after = await VirtualApiKeyModel.findById(virtualKeyId);
      expect(after?.lastUsedAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe("Anthropic Claude Code requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Captures what the proxy forwards upstream so tests can assert messages
  // survive validation unchanged.
  function captureUpstreamParams() {
    const stub = createAnthropicTestClient();
    const captured: { params?: { messages?: unknown[] } } = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          messages: {
            create: async (params: never) => {
              captured.params = params;
              return stub.messages.create(params);
            },
          },
        }) as never,
    );
    return captured;
  }

  async function buildApp() {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    return app;
  }

  function injectMessages(
    app: FastifyInstance,
    agentId: string,
    messages: unknown[],
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/anthropic/${agentId}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.173 (external, sdk-cli)",
        "anthropic-version": "2023-06-01",
        "anthropic-beta":
          "claude-code-20250219,mid-conversation-system-2026-04-07,interleaved-thinking-2025-05-14",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        max_tokens: 1024,
        messages,
      },
    });
  }

  // Claude Code (anthropic-beta: mid-conversation-system-2026-04-07) injects
  // `role: "system"` messages into `messages` for hook output. The proxy must
  // accept them and forward them upstream unchanged.
  test("accepts and forwards mid-conversation system messages", async ({
    makeAgent,
  }) => {
    const captured = captureUpstreamParams();
    const app = await buildApp();

    try {
      const agent = await makeAgent({ name: "System Role Agent" });
      const systemMessage = {
        role: "system",
        content: "SessionStart:startup hook success: OK",
      };

      const response = await injectMessages(app, agent.id, [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            {
              type: "text",
              text: "<system-reminder>context</system-reminder>",
              cache_control: { type: "ephemeral" },
            },
          ],
        },
        systemMessage,
      ]);

      expect(response.statusCode).toBe(200);
      expect(captured.params?.messages?.[1]).toEqual(systemMessage);
    } finally {
      await app.close();
    }
  });

  // Interleaved thinking puts thinking/redacted_thinking blocks in assistant
  // history; server tools and future betas add more block types. All must
  // pass validation and reach the upstream with every field intact (the
  // thinking signature in particular is required on replay).
  test("accepts and forwards thinking, server-tool and unknown content blocks", async ({
    makeAgent,
  }) => {
    const captured = captureUpstreamParams();
    const app = await buildApp();

    try {
      const agent = await makeAgent({ name: "Thinking Blocks Agent" });
      const assistantMessage = {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Let me think...",
            signature: "sig-abc",
          },
          { type: "redacted_thinking", data: "opaque-bytes" },
          {
            type: "server_tool_use",
            id: "srvtoolu_1",
            name: "web_search",
            input: { query: "archestra" },
            caller: { type: "direct" },
          },
          {
            type: "block_type_from_a_future_beta",
            payload: { anything: true },
          },
          { type: "text", text: "Done." },
        ],
      };

      const response = await injectMessages(app, agent.id, [
        { role: "user", content: "hi" },
        assistantMessage,
      ]);

      expect(response.statusCode).toBe(200);
      expect(captured.params?.messages?.[1]).toEqual(assistantMessage);
    } finally {
      await app.close();
    }
  });
});

describe("Anthropic tool call accumulation", () => {
  let anthropicStubOptions: {
    includeToolUse?: boolean;
    interruptAtChunk?: number;
  };

  beforeEach(() => {
    anthropicStubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(anthropicStubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("accumulates tool call input without [object Object] bug", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    anthropicStubOptions.includeToolUse = true;

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Tool Call Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "What's the weather?" }],
        max_tokens: 1024,
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const body = response.body;

    // Verify stream contains tool_use events
    expect(body).toContain("event: content_block_start");
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"get_weather"');

    // Verify tool input is properly accumulated without [object Object]
    expect(body).not.toContain("[object Object]");

    // Verify the tool input contains valid JSON parts
    expect(body).toContain("location");
    expect(body).toContain("San Francisco");
    expect(body).toContain("fahrenheit");
  });

  test("accepts document content blocks in request payloads", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(anthropicProxyRoutes);

    const agent = await makeAgent({ name: "Test Document Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                title: "Spec",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: "JVBERi0xLjQK",
                },
              },
              {
                type: "text",
                text: "Summarize this document.",
              },
            ],
          },
        ],
        max_tokens: 1024,
      },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("Anthropic proxy routing", () => {
  let app: FastifyInstance;
  let mockUpstream: FastifyInstance;
  let upstreamPort: number;

  beforeEach(async () => {
    mockUpstream = Fastify();

    mockUpstream.get("/v1/models", async () => ({
      data: [
        { id: "claude-3-5-sonnet-20241022", type: "model" },
        { id: "claude-3-opus-20240229", type: "model" },
      ],
    }));

    mockUpstream.get("/v1/models/:model", async (request) => ({
      id: (request.params as { model: string }).model,
      type: "model",
    }));

    await mockUpstream.listen({ port: 0 });
    const address = mockUpstream.server.address();
    upstreamPort = typeof address === "string" ? 0 : address?.port || 0;

    app = Fastify();

    await app.register(async (fastify) => {
      const fastifyHttpProxy = (await import("@fastify/http-proxy")).default;
      const API_PREFIX = "/v1/anthropic";
      const MESSAGES_SUFFIX = "/messages";

      await fastify.register(fastifyHttpProxy, {
        upstream: `http://localhost:${upstreamPort}`,
        prefix: API_PREFIX,
        rewritePrefix: "",
        preHandler: (request, reply, next) => {
          const urlPath = request.url.split("?")[0];
          if (request.method === "POST" && urlPath.endsWith(MESSAGES_SUFFIX)) {
            reply.code(400).send({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "Messages requests should use the dedicated endpoint",
              },
            });
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
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

    // Should get 400 because the preHandler blocks proxy forwarding with a clean error response
    expect(response.statusCode).toBe(400);
  });
});

describe("Anthropic delta encoding (claude_metadata sessions)", () => {
  beforeEach(() => {
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("two sequential requests delta-encode on write and reconstruct on read", async ({
    makeAgent,
  }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);

    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const agent = await makeAgent({ name: "Test Delta Agent" });
    const sessionUuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const userId = `user_test_account_1_session_${sessionUuid}`;
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer test-key",
      "user-agent": "test-client",
      "anthropic-version": "2023-06-01",
      "x-api-key": "test-anthropic-key",
    };

    const firstMessages = [{ role: "user", content: "kick off the session" }];
    const secondMessages = [
      ...firstMessages,
      { role: "assistant", content: "working on it" },
      { role: "user", content: "second turn" },
    ];

    const first = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers,
      payload: {
        model: "claude-opus-4-20250514",
        messages: firstMessages,
        max_tokens: 1024,
        metadata: { user_id: userId },
      },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers,
      payload: {
        model: "claude-opus-4-20250514",
        messages: secondMessages,
        max_tokens: 1024,
        metadata: { user_id: userId },
      },
    });
    expect(second.statusCode).toBe(200);

    const { InteractionModel } = await import("@/models");
    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions).toHaveLength(2);
    // Identify the rows by structure rather than array position: both rows are
    // inserted back-to-back with `created_at = now()`, so when they share a
    // millisecond the `ORDER BY created_at ASC` tie-break is non-deterministic.
    const head = interactions.find((i) => i.parentId === null);
    const child = interactions.find((i) => i.parentId !== null);
    expect(head).toBeDefined();
    expect(child).toBeDefined();

    // Session id came from Claude metadata; with no X-Archestra-Agent-Id header
    // the client is auto-attributed to the generic Claude id. The second row
    // chains to the first.
    expect(head?.sessionSource).toBe(CLAUDE_METADATA_SESSION_SOURCE);
    expect(head?.externalAgentId).toBe(CLAUDE_CLIENT_ID);
    expect(head?.sessionId).toBe(sessionUuid);
    expect(head?.threadId).not.toBeNull();
    expect(child?.parentId).toBe(head?.id);
    expect(child?.threadId).toBe(head?.threadId);

    // The read path reconstructs the full request that was originally sent.
    expect((child?.request as { messages: unknown[] }).messages).toEqual(
      secondMessages,
    );
  });
});

describe("Anthropic input-token fallback", () => {
  let stubOptions: {
    zeroInputTokens?: boolean;
    zeroOutputTokens?: boolean;
    cacheReadInputTokens?: number;
  };

  beforeEach(() => {
    stubOptions = {};
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient(stubOptions) as never,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runRequest(
    agentId: string,
    extraPayload: Record<string, unknown> = {},
  ) {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(anthropicProxyRoutes);
    await ModelModel.upsert({
      externalId: "anthropic/claude-opus-4-20250514",
      provider: "anthropic",
      modelId: "claude-opus-4-20250514",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "15.00",
      customPricePerMillionOutput: "75.00",
      lastSyncedAt: new Date(),
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agentId}/v1/messages`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        "user-agent": "test-client",
        "anthropic-version": "2023-06-01",
        "x-api-key": "test-anthropic-key",
      },
      payload: {
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "Hello!" }],
        max_tokens: 1024,
        ...extraPayload,
      },
    });
    expect(response.statusCode).toBe(200);
    return app;
  }

  async function latestInteraction(agentId: string) {
    const { InteractionModel } = await import("@/models");
    const interactions =
      await InteractionModel.getAllInteractionsForProfile(agentId);
    expect(interactions.length).toBeGreaterThan(0);
    return interactions[interactions.length - 1];
  }

  test("non-streaming: zero provider input tokens are replaced by an estimate", async ({
    makeAgent,
  }) => {
    stubOptions.zeroInputTokens = true;
    const agent = await makeAgent({ name: "Zero Input NonStreaming" });

    await runRequest(agent.id);

    const interaction = await latestInteraction(agent.id);
    expect(interaction.inputTokensEstimated).toBe(true);
    // A real estimate of the prompt, not the provider's 0 nor the measured 12.
    expect(interaction.inputTokens).toBeGreaterThan(0);
    expect(interaction.inputTokens).not.toBe(12);
    expect(interaction.cost).toBeTruthy();
  });

  test("streaming: zero provider input tokens are replaced by an estimate", async ({
    makeAgent,
  }) => {
    stubOptions.zeroInputTokens = true;
    const agent = await makeAgent({ name: "Zero Input Streaming" });

    await runRequest(agent.id, { stream: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const interaction = await latestInteraction(agent.id);
    expect(interaction.inputTokensEstimated).toBe(true);
    expect(interaction.inputTokens).toBeGreaterThan(0);
    expect(interaction.inputTokens).not.toBe(12);
    expect(interaction.cost).toBeTruthy();
  });

  test("provider-reported input tokens are recorded as measured, not estimated", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Measured Input" });

    await runRequest(agent.id);

    const interaction = await latestInteraction(agent.id);
    expect(interaction.inputTokensEstimated).toBe(false);
    expect(interaction.inputTokens).toBe(12);
  });

  test("zero input with zero output is not estimated (no output to corroborate)", async ({
    makeAgent,
  }) => {
    stubOptions.zeroInputTokens = true;
    stubOptions.zeroOutputTokens = true;
    const agent = await makeAgent({ name: "Zero Input Zero Output" });

    await runRequest(agent.id);

    const interaction = await latestInteraction(agent.id);
    expect(interaction.inputTokensEstimated).toBe(false);
    expect(interaction.inputTokens).toBe(0);
  });

  test("zero input with cache-read tokens is not estimated (legitimately cached)", async ({
    makeAgent,
  }) => {
    stubOptions.zeroInputTokens = true;
    stubOptions.cacheReadInputTokens = 2000;
    const agent = await makeAgent({ name: "Zero Input Cached" });

    await runRequest(agent.id);

    const interaction = await latestInteraction(agent.id);
    expect(interaction.inputTokensEstimated).toBe(false);
    expect(interaction.inputTokens).toBe(0);
    expect(interaction.cacheReadTokens).toBe(2000);
  });
});
