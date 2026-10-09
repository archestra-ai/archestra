import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import {
  DEFAULT_APP_NAME,
  resolveMcpClientServerName,
} from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { vi } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { CacheKey, cacheManager } from "@/cache-manager";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { AgentModel, OrganizationModel, ToolModel } from "@/models";
import agentRoutes from "@/routes/agent";
import { buildAgentMcpToolList } from "@/routes/mcp-gateway/utils";
import { getObservedMcpToolTokenCount } from "@/services/mcp-tool-token-count";
import { buildClaudeMcpToolDefinitions } from "@/services/mcp-tool-token-estimate";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { User } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import anthropicProxyRoutes from "./anthropic";

setupTestCacheManager();

describe("observed Anthropic MCP tool counts", () => {
  let app: FastifyInstanceWithZod;
  let upstream: FastifyInstance;
  let upstreamRequests: unknown[];
  let upstreamResult: {
    status: number;
    contentType: string;
    encoding?: string;
    chunks: (Buffer | string)[];
    stream?: Readable;
  };
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    config.auth.secret = "tool-count-observation-test-secret";
    upstreamRequests = [];
    upstreamResult = {
      status: 200,
      contentType: "application/json",
      chunks: ['{"input_', 'tokens":12232}'],
    };
    upstream = Fastify();
    upstream.post("/*", async (request, reply) => {
      upstreamRequests.push(request.body);
      if (upstreamResult.encoding)
        reply.header("content-encoding", upstreamResult.encoding);
      return reply
        .code(upstreamResult.status)
        .type(upstreamResult.contentType)
        .send(
          upstreamResult.stream ??
            Readable.from(upstreamResult.chunks, { objectMode: false }),
        );
    });
    config.llm.anthropic.baseUrl = await upstream.listen({ port: 0 });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = user;
      request.organizationId = organizationId;
    });
    await app.register(anthropicProxyRoutes);
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
    await drainBackgroundWork();
    vi.restoreAllMocks();
  });

  test("reuses the existing tool-only provider count without altering the proxy response", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const preview = makePreview(gateway, 20);
    expect(await getObservedMcpToolTokenCount(preview)).toBeNull();
    const request = countRequest(preview);
    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${crypto.randomUUID()}/v1/messages/count_tokens`,
      headers: { authorization: "Bearer test-subscription-credential" },
      payload: request,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"input_tokens":12232}');
    expect(upstreamRequests).toHaveLength(1);
    expect(JSON.stringify(upstreamRequests[0])).not.toContain("[[gwa1.");
    await drainBackgroundWork();
    expect(await getObservedMcpToolTokenCount(preview)).toEqual({
      total: 11732,
      model: request.model,
      observedAt: expect.any(String),
    });
    const stored = await cacheManager.get<Record<string, unknown>>(
      observationKey(preview),
    );
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      "fingerprint",
      "model",
      "observedAt",
      "total",
    ]);
    expect(JSON.stringify(stored)).not.toContain("[[gwa1.");
    expect(JSON.stringify(stored)).not.toContain("documents__read");
    expect(JSON.stringify(stored)).not.toContain(
      "test-subscription-credential",
    );
  });

  test("the authenticated preview prefers matching provider totals and falls back after description or list changes", async ({
    makeAgent,
    makeInternalMcpCatalog,
    makeTool,
    makeAgentTool,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
      toolExposureMode: "full",
    });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({
      name: "documents__read",
      catalogId: catalog.id,
      parameters: { type: "object", properties: { id: { type: "string" } } },
    });
    await makeAgentTool(gateway.id, tool.id);
    const organization = await OrganizationModel.getById(organizationId);
    const serverName = resolveMcpClientServerName({
      gatewayName: gateway.name,
      appName: organization?.appName ?? DEFAULT_APP_NAME,
      isPersonalGateway: gateway.isPersonalGateway,
    });
    const previewUrl = `/api/agents/${gateway.id}/mcp-tool-preview`;
    const before = await app.inject({
      method: "GET",
      url: `${previewUrl}?client=claude-code`,
    });
    expect(before.json().tokenCount.source).toBe("estimate");
    const { tools } = await buildAgentMcpToolList({
      agent: gateway,
      tokenAuth: { organizationId, userId: user.id },
    });
    await postCount(countRequest({ tools, serverName }));
    const measured = await app.inject({
      method: "GET",
      url: `${previewUrl}?client=claude-code`,
    });
    expect(measured.statusCode, measured.body).toBe(200);
    expect(measured.json().tokenCount).toEqual({
      total: 11732,
      source: "claude-provider",
      model: "claude-sonnet-4-5",
      observedAt: expect.any(String),
    });
    expect(measured.json().tools).toEqual(before.json().tools);
    const generic = await app.inject({ method: "GET", url: previewUrl });
    expect(generic.json().tokenCount.source).toBe("estimate");
    await ToolModel.update(tool.id, {
      description: "The upstream description changed.",
    });
    const changed = await app.inject({
      method: "GET",
      url: `${previewUrl}?client=claude-code`,
    });
    expect(changed.json().tokenCount.source).toBe("estimate");
    await AgentModel.update(gateway.id, {
      toolExposureMode: "search_and_run_only",
    });
    const progressive = await app.inject({
      method: "GET",
      url: `${previewUrl}?client=claude-code`,
    });
    expect(progressive.json().toolExposureMode).toBe("search_and_run_only");
    expect(progressive.json().tokenCount.source).toBe("estimate");
  });

  test("normalizes tool fields but preserves schema order, definitions, subsets, and scope", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const preview = makePreview(gateway);
    preview.tools[0].inputSchema = {
      properties: { id: { description: "Record id", type: "string" } },
      type: "object",
    };
    const request = countRequest(preview);
    request.tools = request.tools.map((tool) => ({
      input_schema: {
        properties: tool.input_schema.properties,
        type: tool.input_schema.type,
      },
      description: tool.description,
      name: tool.name,
    }));
    await postCount(request);
    expect(await getObservedMcpToolTokenCount(preview)).toBeNull();
    const matchingRequest = countRequest(preview);
    matchingRequest.tools = matchingRequest.tools.map((tool) => ({
      input_schema: tool.input_schema,
      description: tool.description,
      name: tool.name,
    }));
    await postCount(matchingRequest);
    expect((await getObservedMcpToolTokenCount(preview))?.total).toBe(11732);
    const nestedReorderedRequest = countRequest(preview);
    nestedReorderedRequest.tools[0].input_schema.properties = {
      id: { type: "string", description: "Record id" },
    };
    await postCount(nestedReorderedRequest);
    expect(await getObservedMcpToolTokenCount(preview)).toBeNull();
    await postCount(matchingRequest);
    const changes = [
      { ...preview, serverName: "other-gateway" },
      { ...preview, organizationId: "other-organization" },
      { ...preview, gatewayId: crypto.randomUUID() },
      { ...preview, tools: preview.tools.slice(1) },
      { ...preview, tools: [...preview.tools].reverse() },
      {
        ...preview,
        tools: preview.tools.map((tool) => ({
          ...tool,
          description: `${tool.description} Changed.`,
        })),
      },
      {
        ...preview,
        tools: preview.tools.map((tool) => ({
          ...tool,
          inputSchema: { ...tool.inputSchema, required: ["id"] },
        })),
      },
    ];
    for (const changed of changes)
      expect(await getObservedMcpToolTokenCount(changed)).toBeNull();
    config.llm.anthropic.baseUrl = "https://other-provider.example";
    expect(await getObservedMcpToolTokenCount(preview)).toBeNull();
  });

  test("uses Claude's clipped signed descriptions and misses after signing-key rotation", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const preview = makePreview(gateway);
    preview.tools[0].description += " Long description.".repeat(500);
    await postCount(countRequest(preview));
    expect((await getObservedMcpToolTokenCount(preview))?.total).toBe(11732);
    preview.tools[0].description +=
      " This suffix is outside the client's clipping boundary.";
    expect((await getObservedMcpToolTokenCount(preview))?.total).toBe(11732);
    config.auth.secret = "rotated-signing-secret";
    expect(await getObservedMcpToolTokenCount(makePreview(gateway))).toBeNull();
  });

  test("rejects unknown context fields and unverified, mixed, or mismatched tool identities without affecting forwarding", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const otherGateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const preview = makePreview(gateway);
    const valid = countRequest(preview);
    const other = countRequest(makePreview(otherGateway));
    const invalid = [
      { ...valid, system: "Some context" },
      { ...valid, metadata: {} },
      { ...valid, betas: ["unknown-beta"] },
      { ...valid, messages: [{ role: "user", content: "Another prompt" }] },
      {
        ...valid,
        messages: [
          {
            role: "user",
            content: "foo",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      { ...valid, messages: [...valid.messages, ...valid.messages] },
      { ...valid, tools: [] },
      { ...valid, tools: [valid.tools[0], valid.tools[0]] },
      { ...valid, tools: [valid.tools[0], other.tools[1]] },
      {
        ...valid,
        tools: valid.tools.map((tool) => ({
          ...tool,
          cache_control: { type: "ephemeral" },
        })),
      },
      {
        ...valid,
        tools: valid.tools.map((tool) => ({
          ...tool,
          name: "mcp__gateway__different_name",
        })),
      },
      {
        ...valid,
        tools: valid.tools.map((tool) => ({
          ...tool,
          description: "unsigned",
        })),
      },
      {
        ...valid,
        tools: valid.tools.map((tool) => ({
          ...tool,
          description: tool.description.replace("[[gwa1.", "[[gwa1.A"),
        })),
      },
    ];
    const originalSecret = config.auth.secret;
    config.auth.secret = "another-signing-secret";
    invalid.push(countRequest(makePreview(gateway)));
    config.auth.secret = originalSecret;
    for (const payload of invalid) {
      const response = await postCount(payload);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"input_tokens":12232}');
      expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
    }
    expect(upstreamRequests).toHaveLength(invalid.length);
  });

  test("forwards rejected response shapes and unrelated endpoints byte-for-byte without recording", async ({
    makeAgent,
  }) => {
    const preview = makePreview(
      await makeAgent({ agentType: "mcp_gateway", organizationId }),
    );
    const variants = [
      {
        status: 400,
        contentType: "application/json",
        chunks: ['{"input_tokens":12232}'],
      },
      {
        status: 500,
        contentType: "application/json",
        chunks: ['{"error":"unavailable"}'],
      },
      {
        status: 200,
        contentType: "text/plain",
        chunks: ['{"input_tokens":12232}'],
      },
      {
        status: 200,
        contentType: "application/json",
        encoding: "unsupported-compression",
        chunks: [gzipSync('{"input_tokens":12232}')],
      },
      ...(
        [
          ["br", brotliCompressSync],
          ["gzip", gzipSync],
          ["deflate", deflateSync],
        ] as const
      ).flatMap(([encoding, compress]) => [
        {
          status: 200,
          contentType: "application/json",
          encoding,
          chunks: [Buffer.from("not a compressed response")],
        },
        {
          status: 200,
          contentType: "application/json",
          encoding,
          chunks: [
            compress(
              JSON.stringify({
                input_tokens: 12232,
                padding: "x".repeat(100_000),
              }),
            ),
          ],
        },
      ]),
      {
        status: 200,
        contentType: "application/json",
        chunks: ['{"input_tokens":'],
      },
      {
        status: 200,
        contentType: "application/json",
        chunks: ['{"input_tokens":12232,"padding":"', "x".repeat(5000), '"}'],
      },
      ...["-1", "1.5", "9007199254740992", '"12232"', "null"].map((value) => ({
        status: 200,
        contentType: "application/json",
        chunks: [`{"input_tokens":${value}}`],
      })),
    ];
    for (const variant of variants) {
      upstreamResult = variant;
      const response = await postCount(countRequest(preview));
      expect(response.statusCode).toBe(variant.status);
      expect(response.rawPayload).toEqual(
        Buffer.concat(variant.chunks.map((chunk) => Buffer.from(chunk))),
      );
      expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
    }
    upstreamResult = {
      status: 200,
      contentType: "application/json",
      chunks: ['{"input_tokens":12232}'],
    };
    const unrelated = await postCount(
      countRequest(preview),
      "/v1/anthropic/v1/other_endpoint",
    );
    expect(unrelated.statusCode).toBe(200);
    expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
  });

  for (const [encoding, compress] of [
    ["br", brotliCompressSync],
    ["gzip", gzipSync],
    ["deflate", deflateSync],
  ] as const) {
    test(`observes a ${encoding} count from a bounded copy while forwarding the original bytes and headers`, async ({
      makeAgent,
    }) => {
      const preview = makePreview(
        await makeAgent({ agentType: "mcp_gateway", organizationId }),
        20,
      );
      const compressed = compress('{"input_tokens":12232}');
      upstreamResult = {
        status: 200,
        contentType: "application/json",
        encoding,
        chunks: [compressed.subarray(0, 3), compressed.subarray(3)],
      };
      const response = await postCount(countRequest(preview));
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-encoding"]).toBe(encoding);
      expect(response.rawPayload).toEqual(compressed);
      expect((await getObservedMcpToolTokenCount(preview))?.total).toBe(11732);
    });
  }

  test("uses one slot per gateway, expires after an hour, and tolerates cache failures", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const first = makePreview(gateway, 2);
    const second = makePreview(gateway, 3);
    await postCount(countRequest(first));
    await postCount(countRequest(second));
    expect(await getObservedMcpToolTokenCount(first)).toBeNull();
    expect((await getObservedMcpToolTokenCount(second))?.total).toBe(11732);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 60 * 60 * 1000 + 1);
    expect(await getObservedMcpToolTokenCount(second)).toBeNull();
    clock.mockRestore();
    vi.spyOn(cacheManager, "set").mockRejectedValue(
      new Error("cache unavailable"),
    );
    const response = await postCount(countRequest(first));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"input_tokens":12232}');
    vi.spyOn(cacheManager, "get").mockRejectedValue(
      new Error("cache unavailable"),
    );
    expect(await getObservedMcpToolTokenCount(first)).toBeNull();
  });

  test("does not record an upstream response that fails midway", async ({
    makeAgent,
  }) => {
    const preview = makePreview(
      await makeAgent({ agentType: "mcp_gateway", organizationId }),
    );
    upstreamResult.stream = Readable.from(
      (async function* () {
        yield '{"input_tokens":';
        await new Promise<void>((resolve) => setImmediate(resolve));
        throw new Error("upstream response interrupted");
      })(),
    );
    await expect(postCount(countRequest(preview))).rejects.toThrow();
    await drainBackgroundWork();
    expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
  });

  test("forwards while an optional gateway lookup is stalled and discards its late result", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      agentType: "mcp_gateway",
      organizationId,
    });
    const preview = makePreview(gateway);
    const resolvedGateway = await AgentModel.findGatewayAgentById(gateway.id);
    let resolveLookup: (value: typeof resolvedGateway) => void = () => {};
    const delayedLookup = new Promise<typeof resolvedGateway>((resolve) => {
      resolveLookup = resolve;
    });
    const lookup = vi
      .spyOn(AgentModel, "findGatewayAgentById")
      .mockReturnValueOnce(delayedLookup);
    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/anthropic/v1/messages/count_tokens",
      payload: countRequest(preview),
    });
    try {
      await expect
        .poll(() => upstreamRequests.length, { timeout: 1000 })
        .toBe(1);
      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('{"input_tokens":12232}');
      expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
    } finally {
      resolveLookup(resolvedGateway);
      lookup.mockRestore();
      await responsePromise;
      await drainBackgroundWork();
    }
    expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
  });

  test("client cancellation closes an incomplete response without recording it", async ({
    makeAgent,
  }) => {
    const preview = makePreview(
      await makeAgent({ agentType: "mcp_gateway", organizationId }),
    );
    const stream = new PassThrough();
    upstreamResult.stream = stream;
    stream.write('{"input_tokens":12232');
    const closed = once(stream, "close");
    const address = await app.listen({ port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${address}/v1/anthropic/v1/messages/count_tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(countRequest(preview)),
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(response.text()).rejects.toThrow();
    await closed;
    await drainBackgroundWork();
    expect(await cacheManager.get(observationKey(preview))).toBeUndefined();
  });

  async function postCount(
    payload: object,
    url = "/v1/anthropic/v1/messages/count_tokens",
  ) {
    const response = await app.inject({ method: "POST", url, payload });
    await drainBackgroundWork();
    return response;
  }
});

function makePreview(
  gateway: { id: string; organizationId: string },
  count = 2,
) {
  const tools = Array.from({ length: count }, (_, index) => ({
    name: `documents__read_${index}`,
    description: attestToolDescription({
      organizationId: gateway.organizationId,
      gatewayId: gateway.id,
      advertisedName: `documents__read_${index}`,
      kind: "t",
      description: `Read document ${index}.`,
    }),
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
    } as Record<string, unknown>,
  }));
  return {
    organizationId: gateway.organizationId,
    gatewayId: gateway.id,
    serverName: "gateway",
    tools,
  };
}

function countRequest(
  preview: Parameters<typeof buildClaudeMcpToolDefinitions>[0],
) {
  return {
    model: "claude-sonnet-4-5",
    tools: buildClaudeMcpToolDefinitions(preview),
    messages: [{ role: "user", content: "foo" }],
  };
}

function observationKey(preview: {
  organizationId: string;
  gatewayId: string;
}) {
  return `${CacheKey.McpToolTokenCount}-${preview.organizationId}:${preview.gatewayId}` as const;
}
