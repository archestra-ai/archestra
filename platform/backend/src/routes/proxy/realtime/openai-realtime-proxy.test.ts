import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { type WebSocket as ServerSocket, WebSocket, WebSocketServer } from "ws";
import config from "@/config";
import db, { schema } from "@/database";
import { InteractionModel } from "@/models";
import LimitModel from "@/models/limit";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { handleRealtimeUpgrade } from "./openai-realtime-proxy";

/**
 * The OpenAI SDK's `client.realtime.connect(model=…)` opens a WebSocket to
 * `<base_url>/realtime?model=…` with the client's bearer key. Through
 * Archestra that key is a virtual key: the session is admitted like a Model
 * Router request, the mapped OpenAI key goes upstream, frames pass through
 * both ways, and each `response.done` is logged and priced.
 */
describe("OpenAI realtime sessions through the Model Router", () => {
  let server: Server;
  let origin: string;
  let upstream: WebSocketServer;
  let upstreamConnections: Array<{
    url: string;
    authorization: string | undefined;
    beta: string | undefined;
    socket: ServerSocket;
  }>;

  beforeEach(async () => {
    upstreamConnections = [];
    upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    upstream.on("connection", (socket, request) => {
      upstreamConnections.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        beta: request.headers["openai-beta"] as string | undefined,
        socket,
      });
      socket.send(JSON.stringify({ type: "session.created", session: {} }));
      socket.on("message", (data) => {
        const event = JSON.parse(data.toString()) as { type: string };
        if (event.type === "session.update")
          socket.send(JSON.stringify({ type: "session.updated", session: {} }));
        if (event.type === "response.create") {
          for (const delta of ["AAEC", "AwQF"])
            socket.send(
              JSON.stringify({
                type: "response.output_audio.delta",
                response_id: "resp_1",
                delta,
              }),
            );
          socket.send(JSON.stringify(RESPONSE_DONE));
        }
      });
    });
    await once(upstream, "listening");
    const address = upstream.address();
    if (typeof address !== "object" || !address)
      throw new Error("Missing upstream address");
    config.llm.openai.baseUrl = `http://127.0.0.1:${address.port}/v1`;

    server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end();
    });
    server.on("upgrade", handleRealtimeUpgrade);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const serverAddress = server.address();
    if (typeof serverAddress !== "object" || !serverAddress)
      throw new Error("Missing server address");
    origin = `ws://127.0.0.1:${serverAddress.port}`;
  });

  afterEach(async () => {
    for (const socket of upstream.clients) socket.terminate();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function mappedKey(params: {
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
    const models = await Promise.all(
      ["gpt-realtime-2.1", "gpt-realtime-translate"].map((modelId) =>
        ModelModel.upsert({
          externalId: `openai/${modelId}`,
          provider: "openai",
          modelId,
          inputModalities: ["text", "audio"],
          outputModalities: ["audio"],
          lastSyncedAt: new Date(),
        }),
      ),
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      providerKey.id,
      models.map((model) => model.id),
    );
    return VirtualApiKeyModel.create({
      organizationId: params.organizationId,
      name: "realtime",
      ...accessGrants("org"),
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: providerKey.id },
      ],
    });
  }

  /**
   * Opens a client session; resolves with the socket, or the refusal status.
   * Events are collected from the start: OpenAI's first event can arrive in
   * the same read as the handshake, before a test attaches a listener.
   */
  function connect(url: string, token: string) {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "openai-beta": "realtime=v1",
      },
    });
    const received: Record<string, unknown>[] = [];
    socket.on("message", (data: Buffer) => {
      received.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    events.set(socket, received);
    return new Promise<
      { socket: WebSocket } | { status: number; body: string }
    >((resolve, reject) => {
      socket.once("open", () => resolve({ socket }));
      socket.once("unexpected-response", (_request, response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      socket.once("error", reject);
    });
  }

  const events = new WeakMap<WebSocket, Record<string, unknown>[]>();

  /** The next event of a type, whether it already arrived or is still to come. */
  function nextEvent(socket: WebSocket, type: string) {
    const received = events.get(socket) ?? [];
    const index = received.findIndex((event) => event.type === type);
    if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
    return new Promise<Record<string, unknown>>((resolve) => {
      const listener = (data: Buffer) => {
        const event = JSON.parse(data.toString()) as Record<string, unknown>;
        if (event.type === type) {
          socket.off("message", listener);
          received.splice(received.indexOf(event), 1);
          resolve(event);
        }
      };
      socket.on("message", listener);
    });
  }

  test("forwards the session with the mapped key, logs each response with its transcript and cost, and settles it", async ({
    makeAdmin,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const admin = await makeAdmin();
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const key = await mappedKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 5,
    });

    const opened = await connect(
      `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`,
      key.value,
    );
    if (!("socket" in opened)) throw new Error(`Refused: ${opened.body}`);
    const { socket } = opened;
    await nextEvent(socket, "session.created");
    expect(upstreamConnections).toHaveLength(1);
    expect(upstreamConnections[0]).toMatchObject({
      url: "/v1/realtime?model=gpt-realtime-2.1",
      authorization: "Bearer sk-openai-mapped",
      beta: "realtime=v1",
    });

    socket.send(
      JSON.stringify({
        type: "session.update",
        session: { voice: "alloy", instructions: "Be brief." },
      }),
    );
    await nextEvent(socket, "session.updated");
    socket.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello." }],
        },
      }),
    );
    socket.send(JSON.stringify({ type: "response.create" }));
    const done = await nextEvent(socket, "response.done");
    expect(done).toMatchObject({ response: { id: "resp_1" } });
    socket.close();
    await drainBackgroundWork();

    const rows = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "openai:realtime",
      model: "gpt-realtime-2.1",
      authMethod: "virtual_key",
      virtualKeyId: key.virtualKey.id,
      inputTokens: 260,
      outputTokens: 160,
      cacheReadTokens: 70,
      cost: "0.0165180000",
      request: {
        model: "gpt-realtime-2.1",
        turn: 1,
        session: { voice: "alloy", instructions: "Be brief." },
        input_text: "Say hello.",
      },
      response: {
        id: "resp_1",
        status: "completed",
        output_transcript: "Hello there",
      },
    });
    // The sessions list titles the session by what the user typed.
    const sessions = await InteractionModel.getSessions(
      { limit: 100, offset: 0 },
      admin.id,
      true,
      {},
    );
    expect(
      sessions.data.map((session) => session.lastUserMessagePreview),
    ).toContain("Say hello.");
    // The spoken audio is kept once, as PCM the Logs page plays; the copy in
    // the output items is not. The mapped key never leaves the proxy.
    expect(rows[0].response).toMatchObject({
      output_audio: { format: "pcm16", sample_rate: 24000, data: "AAECAwQF" },
    });
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain("QUJD");
    expect(stored).not.toContain("sk-openai-mapped");
    expect(stored).not.toContain(key.value);
    // Settled against the key's budget like a chat completion.
    const settled = await db.select().from(schema.limitBillingUsageTable);
    expect(settled).toEqual([
      expect.objectContaining({
        model: "gpt-realtime-2.1",
        cost: "0.0165180000",
      }),
    ]);
  });

  test("serves the OpenAI route with a bare model id", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const key = await mappedKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const opened = await connect(
      `${origin}/v1/openai/${agent.id}/realtime?model=gpt-realtime-2.1`,
      key.value,
    );
    if (!("socket" in opened)) throw new Error(`Refused: ${opened.body}`);
    await nextEvent(opened.socket, "session.created");
    expect(upstreamConnections[0]?.url).toBe(
      "/v1/realtime?model=gpt-realtime-2.1",
    );
    opened.socket.close();
  });

  test("refuses a bad key, an unmapped provider, a missing model, and a budget over a session it cannot price", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const key = await mappedKey({
      organizationId: agent.organizationId,
      makeSecret,
      makeLlmProviderApiKey,
    });
    const base = `${origin}/v1/model-router/${agent.id}/realtime`;

    expect(
      await connect(`${base}?model=openai:gpt-realtime-2.1`, "wrong-key"),
    ).toMatchObject({ status: 401 });
    expect(
      await connect(`${base}?model=anthropic:claude-sonnet`, key.value),
    ).toMatchObject({ status: 400 });
    expect(await connect(base, key.value)).toMatchObject({
      status: 400,
      body: expect.stringContaining("model query parameter"),
    });

    // OpenAI bills gpt-realtime-translate per minute, which no event reports,
    // so a budget refuses the session before OpenAI sees it, as the HTTP media
    // routes do (422).
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 5,
    });
    expect(
      await connect(`${base}?model=openai:gpt-realtime-translate`, key.value),
    ).toMatchObject({ status: 422 });
    expect(upstreamConnections).toHaveLength(0);
  });
});

const RESPONSE_DONE = {
  type: "response.done",
  response: {
    id: "resp_1",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_audio", transcript: "Hello there", audio: "QUJD" },
        ],
      },
    ],
    usage: {
      input_tokens: 330,
      output_tokens: 160,
      input_token_details: {
        text_tokens: 70,
        audio_tokens: 250,
        image_tokens: 10,
        cached_tokens: 70,
        cached_tokens_details: { text_tokens: 20, audio_tokens: 50 },
      },
      output_token_details: { text_tokens: 10, audio_tokens: 150 },
    },
  },
};
