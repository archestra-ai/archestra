import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { canonicalJsonObject } from "@/routes/proxy/appa-proxy-hook";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import { openAiResponsesAdapterFactory } from "./adapters";
import type { AppaProxyHookConfig } from "./appa-proxy-hook";
import openAiProxyRoutes from "./routes/openai";

const runtimeUrl = "http://held-history-runtime.test";
const hookUrl = `${runtimeUrl}/hook`;
const model = "gpt-4o";
const reasoningId = "rsn_held_opaque_history";
const reasoningCiphertext = "held-opaque-reasoning-ciphertext";
const providerCallId = "call_held_opaque_history";
const providerArguments = '{"cmd":"pwd"}';
const hookConfig: AppaProxyHookConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  runtimeToken: "held-history-runtime-token",
  sessionHmacSecret: "held-history-session-secret".repeat(3),
  nativeCodexEnabled: true,
};

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper for HTTP boundary tests
const server = useMswServer();

describe("held native opaque history route regression", () => {
  let app: FastifyInstance;
  let historyVisibleBeforeControlRelease = false;
  const originalHookConfig = config.llmProxy.appaHook;

  beforeEach(async () => {
    config.llmProxy.appaHook = hookConfig;
    historyVisibleBeforeControlRelease = false;
    installHeldRuntime();
    app = createRouteApp();
    app.addHook("onSend", async (_request, _reply, payload) => {
      const body = payloadText(payload);
      if (!body.includes("archestra__appa_execute_remedy")) return;
      const issued = await db
        .select({
          providerItemId: schema.appaOpaqueHistoryItemsTable.providerItemId,
        })
        .from(schema.appaOpaqueHistoryItemsTable)
        .where(
          eq(schema.appaOpaqueHistoryItemsTable.providerItemId, reasoningId),
        );
      historyVisibleBeforeControlRelease = issued.length === 1;
    });
    await app.register(openAiProxyRoutes);
    await ModelModel.upsert({
      externalId: `openai/${model}`,
      provider: "openai",
      modelId: model,
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    config.llmProxy.appaHook = originalHookConfig;
    vi.restoreAllMocks();
    await app.close();
  });

  test("records provider reasoning before releasing a held control for streamed and non-streamed Responses", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (request: Record<string, unknown>) =>
              request.stream
                ? responseStream(nativeProviderResponse())
                : nativeProviderResponse(),
          },
        }) as never,
    );
    const user = await makeUser();

    for (const stream of [false, true]) {
      const agent = await makeAgent({
        name: `Held opaque history ${stream ? "stream" : "response"}`,
      });
      await makeMember(user.id as never, agent.organizationId as never);
      const { value: passthroughToken } = await VirtualApiKeyModel.create({
        organizationId: agent.organizationId,
        name: `Held opaque history ${stream ? "stream" : "response"} identity`,
        keyType: "passthrough",
        scope: "personal",
        authorId: user.id,
      });
      const response = await invokeHeldTurn({
        app,
        agentId: agent.id,
        passthroughToken,
        sessionId: `held-opaque-history-${stream ? "stream" : "response"}`,
        stream,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("archestra__appa_execute_remedy");
      expect(response.body).not.toContain(providerCallId);
      if (!stream) expect(historyVisibleBeforeControlRelease).toBe(true);
      const issued = await db
        .select({
          providerItemId: schema.appaOpaqueHistoryItemsTable.providerItemId,
          itemType: schema.appaOpaqueHistoryItemsTable.itemType,
        })
        .from(schema.appaOpaqueHistoryItemsTable)
        .where(
          eq(schema.appaOpaqueHistoryItemsTable.providerItemId, reasoningId),
        );
      expect(issued).toHaveLength(stream ? 2 : 1);
      expect(issued).toContainEqual({
        providerItemId: reasoningId,
        itemType: "reasoning",
      });
      const output = completedOutput(response.body);
      const control = output.find((item) => item.type === "function_call");
      if (typeof control?.call_id !== "string")
        throw new Error("held control was not emitted");
      const metadata =
        await AppaProxyWireModel.findControlMetadataForOrganization({
          organizationId: agent.organizationId,
          controlCallId: control.call_id,
        });
      if (!metadata) throw new Error("held control has no durable frame");
      const scope = {
        sessionId: metadata.session.id,
        ownerScopeHash: metadata.session.ownerScopeHash,
        frameId: metadata.frame.id,
      };
      // Simulate the trusted gateway receipt, not a client approval string.
      const execution = await AppaProxyWireModel.beginControlExecution({
        ...scope,
        selection: { source: "synthetic-gateway" },
      });
      expect(execution.acquired).toBe(true);
      await AppaProxyWireModel.completeControl({
        ...scope,
        receipt: { source: "synthetic-gateway", call: control.call_id },
      });
      const continued = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-virtual-key": passthroughToken,
          "x-archestra-session-id": `held-opaque-history-${stream ? "stream" : "response"}`,
        },
        payload: {
          model,
          stream,
          input: [
            ...codeModeInput(),
            ...output,
            {
              type: "function_call_output",
              call_id: control.call_id,
              output: "completed",
            },
          ],
        },
      });
      expect(continued.statusCode, continued.body).toBe(200);
      expect(continued.body).toContain("exec_command");
      expect(continued.body).not.toContain(reasoningId);
      expect(continued.body).not.toContain(reasoningCiphertext);
      expect(completedOutput(continued.body)).toHaveLength(1);
    }
  });

  test("quarantines a held turn when real opaque-history persistence rejects the provider response", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async () =>
          nativeProviderResponse({
            invalidOpaqueItem: {
              type: "future_provider_item",
              encrypted_content: "untracked-opaque-provider-content",
            },
          }),
      },
    } as never);
    const user = await makeUser();
    const agent = await makeAgent({ name: "Held opaque history quarantine" });
    await makeMember(user.id as never, agent.organizationId as never);
    const { value: passthroughToken } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Held opaque history quarantine identity",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });

    const response = await invokeHeldTurn({
      app,
      agentId: agent.id,
      passthroughToken,
      sessionId: "held-opaque-history-quarantine",
      stream: false,
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(response.body).not.toContain("archestra__appa_execute_remedy");
    expect(response.body).not.toContain(providerCallId);
    expect(response.body).not.toContain(providerArguments);
    expect(response.body).not.toContain(reasoningCiphertext);
    expect(response.body).not.toContain("untracked-opaque-provider-content");
    const [session] = await db
      .select({ state: schema.appaProxySessionsTable.state })
      .from(schema.appaProxySessionsTable)
      .where(eq(schema.appaProxySessionsTable.profileId, agent.id));
    expect(session).toEqual({ state: "quarantined" });
  });

  test("seals stock client-only tool-search bookkeeping without a platform user identity", async ({
    makeAgent,
  }) => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: {
        create: async () => responseStream(nativeToolSearchResponse()),
      },
    } as never);
    const agent = await makeAgent({
      name: "Held tool search credential scope",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-provider-key",
        "x-archestra-session-id": "held-tool-search-credential-scope",
      },
      payload: {
        model,
        stream: true,
        input: [{ type: "message", role: "user", content: "inspect" }],
        tools: [
          {
            type: "function",
            name: "exec_command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
          {
            type: "function",
            name: "write_stdin",
            parameters: {
              type: "object",
              properties: { session_id: { type: "integer" } },
              required: ["session_id"],
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("tool_search_call");
  });
});

function createRouteApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    return reply.status(500).send({
      error: {
        message: "Internal server error",
        type: "api_internal_server_error",
      },
    });
  });
  return app;
}

async function invokeHeldTurn(params: {
  app: FastifyInstance;
  agentId: string;
  passthroughToken: string;
  sessionId: string;
  stream: boolean;
}) {
  const headers = {
    authorization: "Bearer test-key",
    "x-archestra-virtual-key": params.passthroughToken,
    "x-archestra-session-id": params.sessionId,
  };
  const bootstrap = await params.app.inject({
    method: "POST",
    url: `/v1/openai/${params.agentId}/responses`,
    headers,
    payload: {
      model,
      stream: params.stream,
      input: codeModeInput(),
    },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  const bootstrapCallId = bootstrapCallIdFrom(bootstrap.body);

  return await params.app.inject({
    method: "POST",
    url: `/v1/openai/${params.agentId}/responses`,
    headers,
    payload: {
      model,
      stream: params.stream,
      input: [
        ...codeModeInput(),
        {
          type: "custom_tool_call_output",
          call_id: bootstrapCallId,
          output: [
            {
              type: "input_text",
              text: JSON.stringify([
                "exec_command",
                "mcp__gateway__archestra__appa_execute_remedy",
              ]),
            },
          ],
        },
      ],
    },
  });
}

function codeModeInput() {
  return [
    {
      type: "additional_tools",
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [{ type: "custom", name: "exec" }],
        },
        {
          type: "namespace",
          name: "mcp__gateway",
          tools: [{ type: "function", name: "archestra__appa_execute_remedy" }],
        },
      ],
    },
    { type: "message", role: "user", content: "run pwd" },
  ];
}

function nativeProviderResponse(params?: {
  invalidOpaqueItem?: Record<string, unknown>;
}) {
  return {
    id: "resp_held_opaque_history",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output: [
      {
        id: reasoningId,
        type: "reasoning",
        encrypted_content: reasoningCiphertext,
      },
      ...(params?.invalidOpaqueItem ? [params.invalidOpaqueItem] : []),
      {
        id: "fc_held_opaque_history",
        type: "function_call",
        namespace: "functions",
        name: "exec_command",
        call_id: providerCallId,
        arguments: providerArguments,
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function nativeToolSearchResponse() {
  return {
    id: "resp_held_tool_search",
    object: "response",
    created_at: 1,
    model,
    status: "completed",
    output: [
      {
        id: "msg_held_tool_search",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Inspecting tools." }],
      },
      {
        id: "tsc_held_tool_search",
        type: "tool_search_call",
        call_id: "call_held_tool_search",
        execution: "client",
        arguments: { query: "registered tools" },
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function responseStream(response: ReturnType<typeof nativeProviderResponse>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield {
        type: "response.created",
        response: {
          id: response.id,
          object: "response",
          created_at: response.created_at,
          model: response.model,
          status: "in_progress",
          output: [],
        },
      };
      for (const [outputIndex, item] of response.output.entries()) {
        yield {
          type: "response.output_item.done",
          output_index: outputIndex,
          item,
        };
      }
      yield { type: "response.completed", response };
    },
  };
}

function completedOutput(body: string): Array<Record<string, unknown>> {
  if (body.startsWith("{")) return JSON.parse(body).output;
  const completed = body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "response.completed");
  if (!completed) throw new Error("missing completed response");
  return completed.response.output;
}

function bootstrapCallIdFrom(body: string): string {
  if (body.startsWith("{")) {
    const output = (JSON.parse(body) as { output?: unknown }).output;
    const bootstrap = Array.isArray(output)
      ? output.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            (item as Record<string, unknown>).type === "custom_tool_call",
        )
      : undefined;
    const callId = (bootstrap as Record<string, unknown> | undefined)?.call_id;
    if (typeof callId === "string") return callId;
  }
  const chunks = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    );
  const bootstrap = chunks.find(
    (chunk) =>
      chunk.type === "response.output_item.done" &&
      (chunk.item as Record<string, unknown> | undefined)?.type ===
        "custom_tool_call",
  );
  const callId = (bootstrap?.item as Record<string, unknown> | undefined)
    ?.call_id;
  if (typeof callId !== "string")
    throw new Error("missing native bootstrap call");
  return callId;
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (Buffer.isBuffer(payload)) return payload.toString("utf8");
  return "";
}

function installHeldRuntime(): void {
  const batches = new Map<
    string,
    Array<{ call_id: string; tool: string; arguments: Record<string, unknown> }>
  >();
  server.use(
    http.post(hookUrl, () => HttpResponse.json({ decision: "ack" })),
    http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
      HttpResponse.json({
        protocol_version: 1,
        legacy_hooks: false,
        completed_event_replay: true,
        typed_offers: true,
        restriction_acceptance: true,
        human_approval: false,
        parallel_calls: true,
        sanitized_results: true,
        child_workflows: false,
      }),
    ),
    http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
      const requestBody = await request.text();
      const envelope = JSON.parse(requestBody) as {
        event_id: string;
        event: Record<string, unknown>;
      };
      const batchId = String(envelope.event.batch_id ?? "");
      const calls = envelope.event.calls as
        | Array<{
            call_id: string;
            tool: string;
            arguments: Record<string, unknown>;
          }>
        | undefined;
      if (envelope.event.event === "prepare_batch" && calls)
        batches.set(batchId, calls);
      const prepared = batches.get(batchId) ?? [];
      const decision =
        envelope.event.event === "prepare_batch"
          ? {
              decision: "batch_prepared",
              batch_id: batchId,
              root_id: envelope.event.root_id,
              next: "resolve_batch_offer or commit_batch",
              positions: prepared.map((call, position) => ({
                position,
                call_id: call.call_id,
                state: "blocked",
                tool: call.tool,
                arguments_sha256: hashArguments(call.arguments),
                feedback: "requires sanitizer",
                offers: [
                  {
                    offer_id: `offer-${position}`,
                    kind: "sanitizer",
                    root_id: envelope.event.root_id,
                    tool: call.tool,
                    arguments_sha256: hashArguments(call.arguments),
                    batch_id: batchId,
                    position,
                  },
                ],
                review: [],
              })),
            }
          : envelope.event.event === "commit_batch"
            ? {
                decision: "batch_committed",
                batch_id: batchId,
                calls: prepared.map((call, position) => ({
                  position,
                  call_id: call.call_id,
                  dispatch_id: `dispatch-${call.call_id}`,
                  tool: call.tool,
                  arguments_sha256: hashArguments(call.arguments),
                  arguments: call.arguments,
                  spawn_binding: null,
                })),
              }
            : { decision: "ack" };
      return HttpResponse.json({
        protocol_version: 1,
        event_id: envelope.event_id,
        request_sha256: createHash("sha256").update(requestBody).digest("hex"),
        decision,
      });
    }),
    http.post(`${runtimeUrl}/proxy/v1/checkpoints`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        checkpoint_id: `checkpoint-${randomUUID()}`,
        source_scope: { root_id: body.root_id },
        position: 1,
        digest: "held-native-history-checkpoint",
      });
    }),
  );
}

function hashArguments(arguments_: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJsonObject(JSON.stringify(arguments_)))
    .digest("hex");
}
