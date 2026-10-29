import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  ChatOpsChannelBindingModel,
  TaskModel,
  UserTokenModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import mcpGatewayRoutes from "./index";

describe("Agent Runtime status callback", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      throw error;
    });
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("records and clears attention for the authenticated run actor", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
    });
    const taskId = await createRun({
      agentId: agent.id,
      organizationId: organization.id,
      actorUserId: user.id,
    });
    const { value: token } = await UserTokenModel.create(
      user.id,
      organization.id,
    );

    const waiting = await reportStatus({
      app,
      agentId: agent.id,
      taskId,
      token,
      attentionState: "input_required",
    });
    expect(waiting.statusCode, waiting.body).toBe(200);
    expect(waiting.json()).toEqual({ updated: true });
    expect((await AgentRunModel.findByTaskId(taskId))?.attentionState).toBe(
      "input_required",
    );

    const notification = await TaskModel.dequeue([
      "agent_run_attention_notice",
    ]);
    expect(notification?.payload.noticeId).toEqual(expect.any(String));
    await reportStatus({
      app,
      agentId: agent.id,
      taskId,
      token,
      attentionState: "input_required",
    });
    expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();

    const resumed = await reportStatus({
      app,
      agentId: agent.id,
      taskId,
      token,
      attentionState: null,
    });
    expect(resumed.statusCode).toBe(200);
    expect(
      (await TaskModel.dequeue(["agent_run_attention_notice"]))?.payload,
    ).toEqual(notification?.payload);
    expect(
      (await AgentRunModel.findByTaskId(taskId))?.attentionState,
    ).toBeNull();
  });

  test("does not expose a user-owned run to another valid agent token", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    makeServiceAccountToken,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
    });
    const taskId = await createRun({
      agentId: agent.id,
      organizationId: organization.id,
      actorUserId: user.id,
    });
    const { value: organizationToken } = await makeServiceAccountToken({
      organizationId: organization.id,
    });

    const response = await reportStatus({
      app,
      agentId: agent.id,
      taskId,
      token: organizationToken,
      attentionState: "input_required",
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
    expect(response.json()).toEqual({
      error: {
        message: "Run not found",
        type: "api_not_found_error",
      },
    });
    expect(
      (await AgentRunModel.findByTaskId(taskId))?.attentionState,
    ).toBeNull();
  });
  test.for([
    "another-user",
    "another-agent",
    "invalid-token",
    "unknown-task",
  ])("does not queue a notification for %s", async (kind, {
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const caller = kind === "another-user" ? await makeUser() : owner;
    await makeMember(owner.id, org.id, { role: "member" });
    if (caller.id !== owner.id)
      await makeMember(caller.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
    });
    const taskId = await createRun({
      agentId: agent.id,
      organizationId: org.id,
      actorUserId: owner.id,
    });
    const { value: token } = await UserTokenModel.create(caller.id, org.id);
    const otherAgent =
      kind === "another-agent"
        ? await makeAgent({ organizationId: org.id, authorId: owner.id })
        : agent;
    const response = await reportStatus({
      app,
      agentId: otherAgent.id,
      taskId:
        kind === "unknown-task"
          ? "00000000-0000-4000-8000-000000000001"
          : taskId,
      token: kind === "invalid-token" ? "invalid" : token,
      attentionState: "input_required",
    });
    expect([401, 404]).toContain(response.statusCode);
    expect(
      (await AgentRunModel.findByTaskId(taskId))?.attentionState,
    ).toBeNull();
    expect(await TaskModel.dequeue(["agent_run_attention_notice"])).toBeNull();
  });
});

async function createRun(params: {
  agentId: string;
  organizationId: string;
  actorUserId: string;
}): Promise<string> {
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: params.actorUserId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: params.agentId,
    state: "TASK_STATE_WORKING",
  });
  const binding = await ChatOpsChannelBindingModel.create({
    organizationId: params.organizationId,
    provider: "slack",
    channelId: "CTEST",
    workspaceId: "TTEST",
    agentId: params.agentId,
  });
  await AgentRunModel.create({
    organizationId: params.organizationId,
    taskId: task.id,
    agentId: params.agentId,
    actorKind: "user",
    actorId: params.actorUserId,
    actorUserId: params.actorUserId,
    workloadName: `agent-run-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    activeDeadlineSeconds: 3_600,
    virtualApiKeyId: null,
    completionTarget: {
      type: "chatops",
      bindingId: binding.id,
      threadId: "1700000000.000100",
    },
  });
  return task.id;
}

async function reportStatus(params: {
  app: FastifyInstance;
  agentId: string;
  taskId: string;
  token: string;
  attentionState: "input_required" | "auth_required" | null;
}) {
  return await params.app.inject({
    method: "POST",
    url: `/v1/mcp/${params.agentId}/runtime-status`,
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    payload: {
      taskId: params.taskId,
      attentionState: params.attentionState,
    },
  });
}
