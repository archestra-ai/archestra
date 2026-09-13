import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import AppaProxySessionModel from "@/models/appa-proxy-session";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import {
  admitNativeChildCompletion,
  attachNativeChild,
  extractNativeChildRequest,
  prepareNativeChildSpawnPublication,
  resolveNativeChildBinding,
} from "@/services/appa-native-child-correlation";
import { expect, test } from "@/test";
import { ApiError } from "@/types";
import { AppaProxyHookSession, deriveAppaOwnerScope } from "./appa-proxy-hook";
import openAiProxyRoutes from "./routes/openai";

let app: FastifyInstance | undefined;
const originalHook = config.llmProxy.appaHook;

beforeEach(() => {
  config.llmProxy.appaHook = {
    url: "http://native-child-boundary.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-child-boundary-secret".repeat(3),
  };
});

afterEach(async () => {
  config.llmProxy.appaHook = originalHook;
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
});

test("routes a parent spawn result through its durable database session", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const parentClientSessionId = `native-route-parent-${randomUUID()}`;
  const sourceCallId = `call-spawn-${randomUUID()}`;
  const childClientSessionId = `native-route-child-${randomUUID()}`;
  config.llmProxy.appaHook = {
    url: "http://native-route-boundary.test",
    timeoutMs: 100,
    sessionHmacSecret: "native-route-boundary-secret".repeat(3),
    nativeCodexEnabled: true,
  };
  const ownerScopeHash = deriveAppaOwnerScope({
    secret: config.llmProxy.appaHook.sessionHmacSecret,
    profileId: agent.id,
    rawProviderCredential: "native-route-provider-key",
  });
  if (!ownerScopeHash) throw new Error("expected authenticated test owner");
  const parent = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: parentClientSessionId,
    rootId: `native-route-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
    binding: {
      provider: "openai",
      protocol: "openai-responses",
      model: "gpt-4o",
    },
  });
  const parentSessionId = parent.session.id;
  const spawnBinding = `binding-${randomUUID()}`;
  await AppaProxySessionModel.createOutboundIntent({
    turn: parent,
    maxCallsPerSession: 10,
    calls: [
      {
        callId: sourceCallId,
        emittedName: "multi_agent_v1.spawn_agent",
        emittedArguments: '{"task_name":"reader__proxy"}',
        emittedArgumentsCanonical: '{"task_name":"reader__proxy"}',
        appaTargetName: "agent/fixture/lifecycle_child",
        appaTargetArguments: { task_name: "reader" },
      },
    ],
  });
  await AppaProxySessionModel.approveOutboundCallBatch({
    turn: parent,
    calls: [
      {
        callId: sourceCallId,
        dispatchId: `dispatch-${sourceCallId}`,
        spawnBinding,
      },
    ],
  });
  const frame = await AppaProxyWireModel.createFrame({
    sessionId: parentSessionId,
    ownerScopeHash,
    turnId: parent.turnId,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "native-route-request",
    idempotencyKey: `native-route:${parent.turnId}`,
    payload: {
      committedCalls: [
        {
          id: sourceCallId,
          name: "multi_agent_v1.spawn_agent",
          arguments: '{"task_name":"reader__proxy"}',
        },
      ],
    },
    expiresAt: new Date(Date.now() + 60_000),
  });
  await AppaProxyWireModel.addAliases({
    sessionId: parentSessionId,
    ownerScopeHash,
    frameId: frame.id,
    aliases: [
      {
        kind: "task",
        position: 0,
        wireId: "reader__proxy",
        sourceCallId,
        logicalId: "/tasks/root/reader",
        metadata: {
          purpose: "native_child_task",
          clientTaskPath: "/root/reader__proxy",
          clientParentTaskPath: "/root",
        },
      },
    ],
  });
  await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
    sessionId: parentSessionId,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxyWireModel.markIssued({
    sessionId: parentSessionId,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxySessionModel.releaseTurn(parent);
  const acquire = vi
    .spyOn(AppaProxyHookSession, "acquire")
    .mockRejectedValue(new ApiError(503, "runtime acquisition unavailable"));
  app = createRouteApp();
  await app.register(openAiProxyRoutes);

  const response = await app.inject({
    method: "POST",
    url: `/v1/openai/${agent.id}/responses`,
    headers: {
      authorization: "Bearer native-route-provider-key",
      originator: "codex",
      "x-archestra-session-id": parentClientSessionId,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: parentClientSessionId,
        agent_name: "/root",
      }),
    },
    payload: {
      model: "gpt-4o",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "custom", name: "exec" }],
            },
          ],
        },
        {
          type: "function_call_output",
          call_id: sourceCallId,
          output: JSON.stringify({
            agent_id: childClientSessionId,
            status: "started",
          }),
        },
      ],
    },
  });

  expect(response.statusCode, response.body).toBe(503);
  const [boundAlias] = await db
    .select()
    .from(schema.appaProxyWireAliasesTable)
    .where(eq(schema.appaProxyWireAliasesTable.frameId, frame.id));
  expect(boundAlias).toMatchObject({
    sessionId: parentSessionId,
    sourceCallId,
    childThreadId: childClientSessionId,
  });

  const childResponse = await app.inject({
    method: "POST",
    url: `/v1/openai/${agent.id}/responses`,
    headers: {
      authorization: "Bearer native-route-provider-key",
      originator: "codex",
      "x-archestra-session-id": childClientSessionId,
      "thread-id": childClientSessionId,
      "x-codex-parent-thread-id": parentClientSessionId,
      "x-codex-turn-metadata": JSON.stringify({
        parent_thread_id: parentClientSessionId,
        thread_id: childClientSessionId,
        agent_name: "/root/reader__proxy",
      }),
    },
    payload: {
      model: "gpt-4o",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "custom", name: "exec" }],
            },
          ],
        },
      ],
    },
  });
  expect(childResponse.statusCode, childResponse.body).toBe(503);
  expect(acquire).toHaveBeenLastCalledWith(
    expect.objectContaining({
      clientSessionId: childClientSessionId,
      parentClientSessionId,
      ownerScopeHash,
      spawnBinding,
    }),
  );
});

test("attaches a stock native child without a client-provided spawn binding", async ({
  makeAgent,
}) => {
  const agent = await makeAgent();
  const ownerScopeHash = `native-handler-owner-${randomUUID()}`;
  const parentClientSessionId = `native-handler-parent-${randomUUID()}`;
  const childClientSessionId = `native-handler-child-${randomUUID()}`;
  const callId = `call-spawn-${randomUUID()}`;
  const spawnBinding = `binding-${randomUUID()}`;
  const parent = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: parentClientSessionId,
    rootId: `native-handler-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  await AppaProxySessionModel.createOutboundIntent({
    turn: parent,
    maxCallsPerSession: 10,
    calls: [
      {
        callId,
        emittedName: "collaboration.spawn_agent",
        emittedArguments: '{"task_name":"reader","message":"opaque"}',
        emittedArgumentsCanonical: '{"message":"opaque","task_name":"reader"}',
        appaTargetName: "collaboration.spawn_agent",
        appaTargetArguments: {},
      },
    ],
  });
  await AppaProxySessionModel.approveOutboundCallBatch({
    turn: parent,
    calls: [
      {
        callId,
        dispatchId: `dispatch-${callId}`,
        spawnBinding,
      },
    ],
  });
  const frame = await AppaProxyWireModel.createFrame({
    sessionId: parent.session.id,
    ownerScopeHash,
    turnId: parent.turnId,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "native-handler-request",
    idempotencyKey: `native-handler-response:${parent.turnId}`,
    payload: {
      committedCalls: [
        {
          id: callId,
          name: "collaboration.spawn_agent",
          arguments: '{"task_name":"reader","message":"opaque"}',
        },
      ],
    },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const publication = prepareNativeChildSpawnPublication({
    taskAlias: {
      logicalTaskPath: "/tasks/root/reader",
      clientTaskPath: "/root/reader__proxy_abc123",
      wireTaskName: "reader__proxy_abc123",
    },
    position: 0,
    clientParentTaskPath: "/root",
    logicalParentTaskPath: "/tasks/root",
    originalProviderTaskName: "reader",
    approvedCall: { callId, spawnBinding },
  });
  await AppaProxyWireModel.addAliases({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
    aliases: [publication.alias],
    nativeChildCallRewrites: [
      {
        callId,
        spawnBinding,
        expectedEmittedArguments: '{"task_name":"reader","message":"opaque"}',
        expectedEmittedArgumentsCanonical:
          '{"message":"opaque","task_name":"reader"}',
        emittedArguments:
          '{"task_name":"reader__proxy_abc123","message":"opaque"}',
        emittedArgumentsCanonical:
          '{"message":"opaque","task_name":"reader__proxy_abc123"}',
      },
    ],
  });
  await AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaProxyWireModel.markIssued({
    sessionId: parent.session.id,
    ownerScopeHash,
    frameId: frame.id,
  });
  await AppaNativeChildCorrelationModel.bindIssuedSpawnResult({
    parentSessionId: parent.session.id,
    ownerScopeHash,
    profileId: agent.id,
    sourceCallId: callId,
    childClientSessionId,
  });
  await AppaProxySessionModel.releaseTurn(parent);

  const child = extractNativeChildRequest({
    headers: {
      "x-codex-parent-thread-id": parentClientSessionId,
      "thread-id": childClientSessionId,
      "x-codex-turn-metadata": JSON.stringify({
        parent_thread_id: parentClientSessionId,
        thread_id: childClientSessionId,
        agent_name: "/root/reader__proxy_abc123",
      }),
    },
    request: { client_metadata: {} },
  });
  expect(child).toEqual({
    parentClientSessionId,
    childClientSessionId,
    childTaskPath: "/root/reader__proxy_abc123",
  });
  if (!child) throw new Error("expected stock child metadata");
  const resolved = await resolveNativeChildBinding({
    ownerScopeHash,
    profileId: agent.id,
    parentClientSessionId: child.parentClientSessionId,
    childClientSessionId: child.childClientSessionId,
    childTaskPath: child.childTaskPath,
  });
  expect(resolved).toMatchObject({
    logicalTaskPath: "/tasks/root/reader",
    needsAttachment: true,
  });
  if (!resolved.needsAttachment) {
    throw new Error("expected a pending native child attachment");
  }

  // Mirrors AppaProxyHookSession.acquire: only the server-resolved capability is consumed.
  const childTurn = await AppaProxySessionModel.enterTurn({
    profileId: agent.id,
    ownerScopeHash,
    clientSessionId: child.childClientSessionId,
    parentClientSessionId: child.parentClientSessionId,
    spawnBinding: resolved.spawnBinding,
    rootId: `ignored-child-root-${randomUUID()}`,
    turnId: randomUUID(),
    maxSessionsPerOwner: 10,
  });
  await AppaProxySessionModel.markChildStarted(childTurn);
  await attachNativeChild({
    ownerScopeHash,
    profileId: agent.id,
    parentClientSessionId: child.parentClientSessionId,
    childClientSessionId: child.childClientSessionId,
    childTaskPath: child.childTaskPath,
    spawnBinding: resolved.spawnBinding,
  });
  const [alias] = await db
    .select({
      childThreadId: schema.appaProxyWireAliasesTable.childThreadId,
      consumedAt: schema.appaProxyWireAliasesTable.consumedAt,
      emittedArguments: schema.appaProxyCallsTable.emittedArguments,
    })
    .from(schema.appaProxyWireAliasesTable)
    .innerJoin(
      schema.appaProxyCallsTable,
      eq(
        schema.appaProxyWireAliasesTable.sourceCallId,
        schema.appaProxyCallsTable.callId,
      ),
    )
    .where(eq(schema.appaProxyWireAliasesTable.sourceCallId, callId));
  expect(alias).toMatchObject({
    childThreadId: childClientSessionId,
    consumedAt: null,
    emittedArguments: '{"task_name":"reader__proxy_abc123","message":"opaque"}',
  });

  await AppaProxySessionModel.releaseTurn(childTurn);
  await expect(
    resolveNativeChildBinding({
      ownerScopeHash,
      profileId: agent.id,
      parentClientSessionId,
      childClientSessionId,
      childTaskPath: child.childTaskPath,
    }),
  ).resolves.toEqual({
    logicalTaskPath: "/tasks/root/reader",
    needsAttachment: false,
  });
  const completion = [
    "Message Type: FINAL_ANSWER",
    "Task name: /root",
    "Sender: /root/reader__proxy_abc123",
    "Payload:",
    "SYNTHETIC_CHILD_RESULT",
  ].join("\n");
  await admitNativeChildCompletion({
    sessionId: parent.session.id,
    ownerScopeHash,
    profileId: agent.id,
    content: completion,
  });
  await expect(
    admitNativeChildCompletion({
      sessionId: parent.session.id,
      ownerScopeHash,
      profileId: agent.id,
      content: completion,
    }),
  ).rejects.toThrow("attached task alias");
});

function createRouteApp(): FastifyInstance {
  const routeApp = Fastify().withTypeProvider<ZodTypeProvider>();
  routeApp.setValidatorCompiler(validatorCompiler);
  routeApp.setSerializerCompiler(serializerCompiler);
  routeApp.setErrorHandler((error, _request, reply) => {
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
  return routeApp;
}
