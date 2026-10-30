import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel } from "@/models";
import LimitModel from "@/models/limit";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { drainBackgroundWork } from "@/utils/background-work";
import anthropicProxyRoutes from "./anthropic";
import openAiProxyRoutes from "./openai";

/**
 * Every call a catch-all proxy forwards is logged as a `<provider>:passthrough`
 * interaction: the endpoint, the JSON bodies within a size cap, the model and
 * tokens the provider names, and a cost only where OpenAI publishes one.
 */
describe("pass-through logging", () => {
  let app: ReturnType<typeof createFastifyInstance>;
  let upstream: Server;
  let respond: (url: string, authorization: string | undefined) => Response;

  beforeEach(async () => {
    respond = () =>
      new Response("Unexpected upstream request", { status: 500 });
    upstream = createServer(async (request, reply) => {
      for await (const _chunk of request) {
        // Drain the forwarded body; the fixture answers by URL.
      }
      const response = respond(
        request.url ?? "",
        request.headers.authorization,
      );
      reply.writeHead(response.status, Object.fromEntries(response.headers));
      reply.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test upstream");
    config.llm.openai.baseUrl = `http://127.0.0.1:${address.port}/v1`;
    config.llm.anthropic.baseUrl = `http://127.0.0.1:${address.port}`;
    app = createFastifyInstance();
    // The real server runs async onSend hooks (the audit log) before Fastify
    // pipes a proxied body to the client. Logging must not consume the body
    // in that gap: the client then got the headers and no body.
    app.addHook("onSend", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await app.register(openAiProxyRoutes);
    await app.register(anthropicProxyRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  const json = (body: unknown, init?: { status?: number }) =>
    new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json" },
    });

  async function standardKey(params: {
    organizationId: string;
    makeSecret: (overrides: {
      secret: Record<string, unknown>;
    }) => Promise<{ id: string }>;
    makeLlmProviderApiKey: (
      organizationId: string,
      secretId: string,
      overrides: { provider: "openai" },
    ) => Promise<{ id: string }>;
  }) {
    const secret = await params.makeSecret({
      secret: { apiKey: "sk-openai-mapped" },
    });
    const providerKey = await params.makeLlmProviderApiKey(
      params.organizationId,
      secret.id,
      { provider: "openai" },
    );
    return VirtualApiKeyModel.create({
      organizationId: params.organizationId,
      name: "pass-through",
      ...accessGrants("org"),
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
  }

  test("delivers the whole body to the client while logging it", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const listing = {
      object: "list",
      data: Array.from({ length: 200 }, (_, index) => ({
        id: `file-${index}`,
        object: "file",
        filename: `upload-${index}.jsonl`,
      })),
    };
    respond = () => json(listing);

    const response = await app.inject({
      method: "GET",
      url: `/v1/openai/${agent.id}/files`,
      headers: { authorization: `Bearer ${key.value}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(listing);
    await drainBackgroundWork();
    const [row] = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(row).toMatchObject({
      type: "openai:passthrough",
      request: { method: "GET", path: "/files" },
      response: { status: 200, body: listing },
    });
  });

  test("logs a moderation call with its bodies, the key it ran as, and no charge", async ({
    makeAdmin,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const admin = await makeAdmin();
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    let upstreamAuthorization: string | undefined;
    respond = (_url, authorization) => {
      upstreamAuthorization = authorization;
      return json({
        id: "modr-1",
        model: "omni-moderation-latest",
        results: [{ flagged: false }],
      });
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/moderations?foo=bar`,
      headers: { authorization: `Bearer ${key.value}` },
      payload: { model: "omni-moderation-latest", input: "hello" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "modr-1" });
    expect(upstreamAuthorization).toBe("Bearer sk-openai-mapped");
    await drainBackgroundWork();

    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "openai:passthrough",
      model: "omni-moderation-latest",
      authMethod: "virtual_key",
      virtualKeyId: key.virtualKey.id,
      cost: "0.0000000000",
      inputTokens: null,
      outputTokens: null,
      request: {
        method: "POST",
        path: "/moderations",
        query: "foo=bar",
        content_type: "application/json",
        body: { model: "omni-moderation-latest", input: "hello" },
      },
      response: {
        status: 200,
        content_type: "application/json",
        body: { id: "modr-1", results: [{ flagged: false }] },
      },
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
    // Neither credential enters the log.
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("sk-openai-mapped");
    expect(stored).not.toContain(key.value);
    // The sessions list titles the session by the call, not "API session".
    const sessions = await InteractionModel.getSessions(
      { limit: 100, offset: 0 },
      admin.id,
      true,
      {},
    );
    expect(
      sessions.data.map((session) => session.lastUserMessagePreview),
    ).toContain("POST /moderations?foo=bar");
  });

  test("records a listing without a model or cost, a refusal with its status, and reported tokens", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    respond = (url) =>
      url.startsWith("/v1/files")
        ? json({ object: "list", data: [] })
        : url.startsWith("/v1/batches")
          ? json({ error: { message: "No such batch" } }, { status: 404 })
          : json({ object: "response", usage: { input_tokens: 12 } });
    const headers = { authorization: `Bearer ${key.value}` };

    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/openai/${agent.id}/files`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/batches`,
          headers,
          payload: { input_file_id: "file-1", endpoint: "/v1/embeddings" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/responses/input_tokens`,
          headers,
          payload: { model: "gpt-4o", input: "hello" },
        })
      ).statusCode,
    ).toBe(200);
    await drainBackgroundWork();

    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    const byPath = new Map(
      rows.map((row) => [(row.request as { path: string }).path, row]),
    );
    expect([...byPath.keys()].sort()).toEqual([
      "/batches",
      "/files",
      "/responses/input_tokens",
    ]);
    expect(byPath.get("/files")).toMatchObject({
      model: null,
      cost: null,
      request: { method: "GET" },
      response: { status: 200, body: { object: "list" } },
    });
    expect(byPath.get("/batches")).toMatchObject({
      model: null,
      cost: "0.0000000000",
      response: { status: 404, body: { error: { message: "No such batch" } } },
    });
    expect(byPath.get("/responses/input_tokens")).toMatchObject({
      model: "gpt-4o",
      cost: "0.0000000000",
      inputTokens: 12,
      outputTokens: null,
    });
  });

  // A batch reports no cost the gateway can settle, so it would escape the
  // key's budget. Listings and moderation cost nothing and stay available.
  test("refuses a batch while the key has a hard budget, but still lists files and moderates", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 0,
      model: null,
      lastCleanup: new Date(),
    });
    const forwarded: string[] = [];
    respond = (url) => {
      forwarded.push(url);
      return url.startsWith("/v1/files")
        ? json({ object: "list", data: [] })
        : url.startsWith("/v1/moderations")
          ? json({ id: "modr-1", results: [{ flagged: false }] })
          : json({ id: "batch-1", object: "batch" });
    };
    const headers = { authorization: `Bearer ${key.value}` };

    const refused = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/batches`,
      headers,
      payload: {
        input_file_id: "file-1",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toEqual({
      error: {
        message:
          "This pass-through operation reports no cost the gateway can count, so it cannot run while a budget applies.",
        type: "unknown_api_error",
      },
    });
    expect(forwarded).toEqual([]);

    const files = await app.inject({
      method: "GET",
      url: `/v1/openai/${agent.id}/files`,
      headers,
    });
    expect(files.statusCode).toBe(200);
    const moderation = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/moderations`,
      headers,
      payload: { model: "omni-moderation-latest", input: "hello" },
    });
    expect(moderation.statusCode).toBe(200);
    expect(moderation.json()).toMatchObject({ id: "modr-1" });
    expect(forwarded).toEqual(["/v1/files", "/v1/moderations"]);
  });

  test("forwards a batch for a key with no budget", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    let upstreamAuthorization: string | undefined;
    respond = (_url, authorization) => {
      upstreamAuthorization = authorization;
      return json({ id: "batch-1", object: "batch" });
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/batches`,
      headers: { authorization: `Bearer ${key.value}` },
      payload: {
        input_file_id: "file-1",
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "batch-1", object: "batch" });
    expect(upstreamAuthorization).toBe("Bearer sk-openai-mapped");
  });

  test("keeps a large or compressed answer within the cap and marks streams", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent();
    const key = await standardKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const large = JSON.stringify({ data: "x".repeat(300 * 1024) });
    respond = (url) =>
      url.startsWith("/v1/files/large")
        ? new Response(large, {
            headers: { "content-type": "application/json" },
          })
        : url.startsWith("/v1/files/gzip")
          ? new Response(
              new Uint8Array(gzipSync(JSON.stringify({ id: "file-1" }))),
              {
                headers: {
                  "content-type": "application/json",
                  "content-encoding": "gzip",
                },
              },
            )
          : new Response("event: ping\ndata: {}\n\n", {
              headers: { "content-type": "text/event-stream" },
            });
    const headers = { authorization: `Bearer ${key.value}` };

    for (const path of ["/files/large", "/files/gzip", "/files/stream"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/openai/${agent.id}${path}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
    }
    await drainBackgroundWork();

    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    const byPath = new Map(
      rows.map((row) => [(row.request as { path: string }).path, row]),
    );
    expect(byPath.get("/files/large")?.response).toMatchObject({
      status: 200,
      bytes: Buffer.byteLength(large),
      truncated: true,
    });
    expect(
      (byPath.get("/files/large")?.response as { body?: unknown }).body,
    ).toBeUndefined();
    expect(byPath.get("/files/gzip")?.response).toMatchObject({
      status: 200,
      body: { id: "file-1" },
    });
    expect(byPath.get("/files/stream")?.response).toMatchObject({
      status: 200,
      content_type: "text/event-stream",
      streamed: true,
    });
  });

  test("attributes an Anthropic token count to the passthrough key's owner", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    respond = () => json({ input_tokens: 42 });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages/count_tokens`,
      headers: {
        "x-archestra-virtual-key": token,
        "x-api-key": "sk-ant-caller",
      },
      payload: {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(response.statusCode).toBe(200);
    await drainBackgroundWork();

    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "anthropic:passthrough",
      model: "claude-sonnet-4-5",
      authMethod: "passthrough_virtual_key",
      userId: user.id,
      cost: "0.0000000000",
      inputTokens: 42,
      request: { method: "POST", path: "/v1/messages/count_tokens" },
      response: { status: 200, body: { input_tokens: 42 } },
    });
    expect(rows[0].passthroughVirtualKeyId).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain("sk-ant-caller");
  });
});
