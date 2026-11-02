import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect as connectTcp } from "node:net";
import {
  type RawData,
  type WebSocket as ServerSocket,
  WebSocket,
  WebSocketServer,
} from "ws";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { InteractionModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import LimitModel from "@/models/limit";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import {
  accessGrants,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
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
    /** Event types OpenAI received, in order. */
    received: string[];
    /** Whether server voice detection would start a response itself. */
    createResponse: boolean;
  }>;
  /** Whether OpenAI rejects an update to turn detection, as some sessions do. */
  let rejectTurnDetectionUpdates: boolean;
  /** How long OpenAI takes to send `session.created` once connected. */
  let sessionCreatedDelayMs: number;

  beforeEach(async () => {
    upstreamConnections = [];
    rejectTurnDetectionUpdates = false;
    sessionCreatedDelayMs = 0;
    upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    upstream.on("connection", (socket, request) => {
      const connection = {
        url: request.url ?? "",
        authorization: request.headers.authorization,
        beta: request.headers["openai-beta"] as string | undefined,
        socket,
        received: [] as string[],
        createResponse: true,
      };
      upstreamConnections.push(connection);
      // OpenAI's default: server voice detection that answers each turn.
      const created = JSON.stringify({
        type: "session.created",
        session: {
          turn_detection: { type: "server_vad", create_response: true },
        },
      });
      // OpenAI handles the client's events only once the session exists.
      if (!sessionCreatedDelayMs) socket.send(created);
      const sessionReady = new Promise<void>((resolve) => {
        if (!sessionCreatedDelayMs) return resolve();
        setTimeout(() => {
          socket.send(created);
          resolve();
        }, sessionCreatedDelayMs);
      });
      socket.on("message", (data) => {
        void sessionReady.then(() => handle(data));
      });
      const handle = (data: RawData) => {
        const event = JSON.parse(data.toString()) as {
          type: string;
          event_id?: string;
          session?: {
            instructions?: string;
            turn_detection?: { create_response?: boolean } | null;
          };
        };
        connection.received.push(event.type);
        if (
          event.type === "session.update" &&
          rejectTurnDetectionUpdates &&
          event.session &&
          "turn_detection" in event.session
        ) {
          socket.send(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                code: "unknown_parameter",
                message: "Unknown parameter.",
                event_id: event.event_id,
              },
            }),
          );
          return;
        }
        if (event.type === "session.update") {
          const turnDetection = event.session?.turn_detection;
          if (turnDetection === null) connection.createResponse = false;
          else if (turnDetection)
            connection.createResponse = turnDetection.create_response !== false;
          socket.send(
            // Echoes the instructions, so a reply shows which update it answers.
            JSON.stringify({
              type: "session.updated",
              session: { instructions: event.session?.instructions },
            }),
          );
        }
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
        // Stands in for the user finishing a spoken turn.
        if (event.type === "input_audio_buffer.commit") {
          socket.send(
            JSON.stringify({ type: "input_audio_buffer.speech_stopped" }),
          );
          socket.send(JSON.stringify({ type: "input_audio_buffer.committed" }));
          if (connection.createResponse)
            socket.send(JSON.stringify(RESPONSE_DONE));
        }
        // A reply long enough to have many output items.
        if (event.type === "conversation.item.retrieve")
          socket.send(
            JSON.stringify({
              type: "response.done",
              response: {
                ...RESPONSE_DONE.response,
                id: "resp_long",
                output: Array.from({ length: 40 }, (_, index) => ({
                  type: "message",
                  role: "assistant",
                  content: [
                    { type: "output_audio", transcript: `Part ${index}.` },
                  ],
                })),
              },
            }),
          );
      };
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

  /** Sends a raw upgrade request; resolves with the response once the socket closes. */
  async function rawUpgrade(path: string, headers: Record<string, string>) {
    const socket = connectTcp(Number(new URL(origin).port), "127.0.0.1");
    await once(socket, "connect");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n${Object.entries(
        headers,
      )
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("")}\r\n`,
    );
    await once(socket, "close");
    return Buffer.concat(chunks).toString();
  }

  /** Sends a frame the session logs, then completes one response. */
  async function respond(socket: WebSocket) {
    socket.send(JSON.stringify({ type: "response.create" }));
    return nextEvent(socket, "response.done");
  }

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
    // Logs keep media only when the organization turns it on.
    await OrganizationModel.patch(agent.organizationId, {
      keepMediaInLogs: true,
    });
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

  test("a deeply nested frame neither crashes the backend nor reaches the log whole", async ({
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
      `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`,
      key.value,
    );
    if (!("socket" in opened)) throw new Error(`Refused: ${opened.body}`);
    const { socket } = opened;
    await nextEvent(socket, "session.created");

    let nested = '{"voice":"alloy"}';
    for (let index = 0; index < 20_000; index++) nested = `{"a":${nested}}`;
    socket.send(`{"type":"session.update","session":{"tools":${nested}}}`);
    await nextEvent(socket, "session.updated");
    await respond(socket);
    socket.close();
    await drainBackgroundWork();

    const [row] = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(JSON.stringify(row.request)).toContain("[nested too deeply to log]");
  });

  test("keeps a bounded share of the typed text for the log", async ({
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
      `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`,
      key.value,
    );
    if (!("socket" in opened)) throw new Error(`Refused: ${opened.body}`);
    const { socket } = opened;
    await nextEvent(socket, "session.created");
    for (let index = 0; index < 40; index++)
      socket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "x".repeat(65_536) }],
          },
        }),
      );
    await respond(socket);
    socket.close();
    await drainBackgroundWork();

    const [row] = await InteractionModel.getAllInteractionsForProfile(agent.id);
    const inputText = (row.request as { input_text: string }).input_text;
    expect(inputText.length).toBeLessThan(70_000);
    expect(inputText.endsWith("[input truncated]")).toBe(true);
  });

  test("checks the budget before each response, and ends a session whose response spent it", async ({
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
    const budget = await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 100,
      lastCleanup: new Date(),
    });
    const url = `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`;
    const budgetRefusal = (socket: WebSocket) =>
      expect(events.get(socket)).toContainEqual(
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({ code: "budget_exceeded" }),
        }),
      );

    // A response the client asks for waits for the check.
    const asked = await connect(url, key.value);
    if (!("socket" in asked)) throw new Error(`Refused: ${asked.body}`);
    await nextEvent(asked.socket, "session.created");
    await respond(asked.socket);
    await drainBackgroundWork();
    await LimitModel.patch(budget.id, { limitValue: 0 });
    const askedClosed = once(asked.socket, "close");
    asked.socket.send(JSON.stringify({ type: "response.create" }));
    expect((await askedClosed)[0]).toBe(1008);
    budgetRefusal(asked.socket);
    expect(
      upstreamConnections[0].received.filter(
        (type) => type === "response.create",
      ),
    ).toHaveLength(1);
  });

  test("starts the response to a spoken turn itself under a budget, and never once the budget is spent", async ({
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
    const url = `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`;
    const budgetRefusal = (socket: WebSocket) =>
      expect(events.get(socket)).toContainEqual(
        expect.objectContaining({
          type: "error",
          error: expect.objectContaining({ code: "budget_exceeded" }),
        }),
      );

    // Without a budget, OpenAI answers the turn itself, untouched.
    const free = await connect(url, key.value);
    if (!("socket" in free)) throw new Error(`Refused: ${free.body}`);
    await nextEvent(free.socket, "session.created");
    free.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await nextEvent(free.socket, "response.done");
    expect(upstreamConnections[0].received).toEqual([
      "input_audio_buffer.commit",
    ]);
    free.socket.close();

    // Under a budget, OpenAI's own response is off and the proxy asks for
    // the turn's response after the check; the client sees no extra update.
    const budget = await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 100,
      lastCleanup: new Date(),
    });
    const gated = await connect(url, key.value);
    if (!("socket" in gated)) throw new Error(`Refused: ${gated.body}`);
    await nextEvent(gated.socket, "session.created");
    await vi.waitFor(() =>
      expect(upstreamConnections[1].createResponse).toBe(false),
    );
    gated.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await nextEvent(gated.socket, "response.done");
    expect(upstreamConnections[1].received).toEqual([
      "session.update",
      "input_audio_buffer.commit",
      "response.create",
    ]);
    expect(events.get(gated.socket)?.map((event) => event.type)).not.toContain(
      "session.updated",
    );
    // A client that sets turn detection keeps its settings, without
    // OpenAI's own responses.
    gated.socket.send(
      JSON.stringify({
        type: "session.update",
        session: { turn_detection: { type: "semantic_vad" } },
      }),
    );
    await nextEvent(gated.socket, "session.updated");
    expect(upstreamConnections[1].createResponse).toBe(false);

    // Spent elsewhere: the next spoken turn starts nothing upstream.
    await drainBackgroundWork();
    await LimitModel.patch(budget.id, { limitValue: 0 });
    const closed = once(gated.socket, "close");
    gated.socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    expect((await closed)[0]).toBe(1008);
    budgetRefusal(gated.socket);
    expect(
      upstreamConnections[1].received.filter(
        (type) => type === "response.create",
      ),
    ).toHaveLength(1);
  });

  test("holds a budgeted session's frames until OpenAI turns its own responses off, and ends the session if it will not", async ({
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
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.virtualKey.id,
      limitType: "token_cost",
      limitValue: 100,
      lastCleanup: new Date(),
    });
    const open = async () => {
      const session = await connect(
        `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`,
        key.value,
      );
      if (!("socket" in session)) throw new Error(`Refused: ${session.body}`);
      return session.socket;
    };
    const instructions = JSON.stringify({
      type: "session.update",
      session: { instructions: "Be brief." },
    });
    // OpenAI's first event comes late, so the client's update is sent first.
    sessionCreatedDelayMs = 200;

    // The early update waits for the proxy's own, and gets its own reply.
    const early = await open();
    early.send(instructions);
    expect((await nextEvent(early, "session.updated")).session).toEqual({
      instructions: "Be brief.",
    });
    expect(upstreamConnections[0].received).toEqual([
      "session.update",
      "session.update",
    ]);
    expect(upstreamConnections[0].createResponse).toBe(false);
    early.close();

    // Rejected, the proxy's update ends the session before the client's
    // update leaves. The client hears why, not OpenAI's reply to an update
    // it never sent.
    rejectTurnDetectionUpdates = true;
    const rejected = await open();
    const closed = once(rejected, "close");
    rejected.send(instructions);
    expect((await closed)[0]).toBe(1008);
    expect(
      events
        .get(rejected)
        ?.filter((event) => event.type === "error")
        .map((event) => (event.error as { code: string }).code),
    ).toEqual(["budget_check_unavailable"]);
    expect(upstreamConnections[1].received).toEqual(["session.update"]);

    // What waits is bounded: past one frame's worth, the session ends and
    // the held audio goes nowhere.
    rejectTurnDetectionUpdates = false;
    sessionCreatedDelayMs = 1_000;
    const flooded = await open();
    const floodedClosed = once(flooded, "close");
    const append = JSON.stringify({
      type: "input_audio_buffer.append",
      audio: "A".repeat(9 * 1024 * 1024),
    });
    flooded.send(append);
    flooded.send(append);
    expect((await floodedClosed)[0]).toBe(1008);
    expect(events.get(flooded)).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({ code: "session_not_ready" }),
      }),
    );
    expect(upstreamConnections[2].received).toEqual([]);
  });

  test("logs every output item of a long reply, however many there are", async ({
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
      `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`,
      key.value,
    );
    if (!("socket" in opened)) throw new Error(`Refused: ${opened.body}`);
    await nextEvent(opened.socket, "session.created");
    opened.socket.send(JSON.stringify({ type: "conversation.item.retrieve" }));
    await nextEvent(opened.socket, "response.done");
    opened.socket.close();
    await drainBackgroundWork();

    const [row] = await InteractionModel.getAllInteractionsForProfile(agent.id);
    const transcript = (row.response as { output_transcript: string })
      .output_transcript;
    expect(transcript).toContain("Part 0.");
    expect(transcript).toContain("Part 39.");
  });

  test("refuses a session while throughput limits or enforced Guardrails apply", async ({
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
    const url = `${origin}/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`;

    vi.spyOn(enterpriseTier, "isOpenappaActive").mockReturnValue(true);
    await GuardrailsDeploymentModel.setEnabled(true);
    expect(await connect(url, key.value)).toMatchObject({
      status: 403,
      body: expect.stringContaining("Guardrails"),
    });
    await GuardrailsDeploymentModel.setEnabled(false);
    vi.restoreAllMocks();

    await LimitModel.create({
      entityType: "organization",
      entityId: agent.organizationId,
      limitType: "requests_per_minute",
      limitValue: 10,
    });
    expect(await connect(url, key.value)).toMatchObject({
      status: 400,
      body: expect.stringContaining("throughput limits"),
    });
    expect(upstreamConnections).toHaveLength(0);
  });

  test("dials OpenAI only for a valid handshake, and closes it when the upgrade fails", async ({
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
    const path = `/v1/model-router/${agent.id}/realtime?model=openai:gpt-realtime-2.1`;

    const invalidKey = await rawUpgrade(path, {
      Authorization: `Bearer ${key.value}`,
      "Sec-WebSocket-Key": "not-a-key",
    });
    expect(invalidKey).toMatch(/^HTTP\/1\.1 400 /);
    expect(upstreamConnections).toHaveLength(0);

    // A handshake the WebSocket server still refuses after OpenAI answered.
    const refused = await rawUpgrade(path, {
      Authorization: `Bearer ${key.value}`,
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Protocol": ",",
    });
    expect(refused).toMatch(/^HTTP\/1\.1 400 /);
    await vi.waitFor(() =>
      expect(
        upstreamConnections.map(({ socket }) => socket.readyState),
      ).toEqual([WebSocket.CLOSED]),
    );
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
