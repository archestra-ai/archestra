import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { afterEach, beforeEach, vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { consumeHitlRuling, stageHitlReview } from "@/openappa/hitl-review";
import { bindRuntimeHitlReview } from "@/openappa/runtime-hitl-review";
import agentRuntimeRoutes from "@/routes/agent-runtime/agent-runtime.routes";
import { startDetachedAgentTask } from "@/services/agent-runtime/start-task";
import { describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useRouteTestApp } from "@/test/route-test-app";
import { shareForTest } from "@/test/sharing";

vi.mock("@/services/agent-runtime/start-task", () => ({
  cancelDetachedAgentTask: vi.fn(),
  startDetachedAgentTask: vi.fn(),
}));

setupTestCacheManager();

const routesWithAudit: FastifyPluginAsyncZod = async (app) => {
  registerAuditLogHook(app);
  await app.register(agentRuntimeRoutes);
};
describe("agent run OpenAPPA review", () => {
  const ctx = useRouteTestApp(routesWithAudit);
  const previousFeatureEnabled = config.agentRuntime.enabled;
  const previousClusterReachable = Reflect.get(
    agentRuntimeManager,
    "clusterReachable",
  );

  beforeEach(() => {
    config.agentRuntime.enabled = true;
    Reflect.set(agentRuntimeManager, "clusterReachable", true);
    vi.mocked(startDetachedAgentTask).mockClear();
  });

  afterEach(() => {
    config.agentRuntime.enabled = previousFeatureEnabled;
    Reflect.set(
      agentRuntimeManager,
      "clusterReachable",
      previousClusterReachable,
    );
  });

  test("the owner records an approval the runtime consumes, and a lost steer does not start a workspace", async ({
    makeAgent,
  }) => {
    const fixture = await ownedRuntime({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      makeAgent,
    });
    await stageAndBind(fixture, "offer-1");
    vi.spyOn(agentRuntimeManager, "steer").mockRejectedValue(
      new Error("pod is gone"),
    );

    const visible = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-runs/${fixture.taskId}/openappa-review`,
    });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json()).toMatchObject({
      status: "pending",
      canDecide: true,
      offerId: "offer-1",
      text: "Review this call.",
    });

    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${fixture.taskId}/openappa-review`,
      payload: { decision: "approve", offerId: "offer-1" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      decision: "approve",
      offerId: "offer-1",
      steered: false,
    });
    expect(startDetachedAgentTask).not.toHaveBeenCalled();
    expect(
      await consumeHitlRuling({ session: fixture.session, offerId: "offer-1" }),
    ).toBe("approve");
    const audits = await db
      .select()
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, fixture.taskId));
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "agentRun.reviewDecided",
          before: { openappaReview: { offerId: "offer-1", decision: null } },
          after: {
            openappaReview: {
              offerId: "offer-1",
              decision: "approve",
              steered: false,
            },
          },
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain("Review this call");
  });

  test("a model-supplied yes is not a decision, and another user cannot decide", async ({
    makeAgent,
    makeUser,
  }) => {
    const fixture = await ownedRuntime({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      makeAgent,
    });
    await stageAndBind(fixture, "offer-1");
    const invalid = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${fixture.taskId}/openappa-review`,
      payload: { decision: "yes", offerId: "offer-1" },
    });
    expect(invalid.statusCode).toBe(400);

    const other = await makeUser();
    const otherRun = await ownedRuntime({
      organizationId: ctx.organizationId,
      userId: other.id,
      makeAgent,
    });
    await stageAndBind(otherRun, "offer-other");
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${otherRun.taskId}/openappa-review`,
      payload: { decision: "approve", offerId: "offer-other" },
    });
    expect(denied.statusCode).toBe(404);
    expect(
      await consumeHitlRuling({
        session: otherRun.session,
        offerId: "offer-other",
      }),
    ).toBeUndefined();
  });

  test("a shared reader sees status only and cannot approve", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, ctx.organizationId);
    await makeMember(ctx.user.id, ctx.organizationId);
    const fixture = await ownedRuntime({
      organizationId: ctx.organizationId,
      userId: owner.id,
      makeAgent,
    });
    await stageAndBind(fixture, "offer-shared", "secret-argument");
    await shareForTest({
      organizationId: ctx.organizationId,
      resource: "agentRun",
      scope: fixture.taskId,
      visibility: "user",
      userIds: [ctx.user.id],
    });

    const visible = await ctx.app.inject({
      method: "GET",
      url: `/api/agent-runs/${fixture.taskId}/openappa-review`,
    });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json()).toEqual({
      status: "pending",
      canDecide: false,
      offerId: null,
      text: null,
      tool: null,
      arguments: null,
    });
    expect(visible.body).not.toContain("secret-argument");

    const denied = await ctx.app.inject({
      method: "POST",
      url: `/api/agent-runs/${fixture.taskId}/openappa-review`,
      payload: { decision: "approve", offerId: "offer-shared" },
    });
    expect(denied.statusCode).toBe(404);
  });
});

async function stageAndBind(
  fixture: {
    organizationId: string;
    session: {
      organization_id: string;
      caller_id: string;
      session_id: string;
    };
  },
  offerId: string,
  argument = '{"value":1}',
) {
  await stageHitlReview({
    session: fixture.session,
    review: {
      offerId,
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: argument,
    },
  });
  await bindRuntimeHitlReview({
    session: fixture.session,
    review: {
      offerId,
      text: "Review this call.",
      tool: "mcp/example/write",
      arguments: argument,
    },
  });
}

async function ownedRuntime(params: {
  organizationId: string;
  userId: string;
  makeAgent: (input: {
    organizationId: string;
    authorId: string;
    agentType: "agent";
    runtime: {
      image: string;
      command: null;
      inferenceProtocol: "openai_responses";
      backend: "kubernetes";
      steerMode: "pipe";
      privileged: false;
      resources: null;
      environment: null;
      credentials: null;
      ttlHours: null;
      idleTimeoutMinutes: null;
    };
  }) => Promise<{ id: string }>;
}) {
  const agent = await params.makeAgent({
    organizationId: params.organizationId,
    authorId: params.userId,
    agentType: "agent",
    runtime: {
      image: "example.com/coding-agent:latest",
      command: null,
      inferenceProtocol: "openai_responses",
      backend: "kubernetes",
      steerMode: "pipe",
      privileged: false,
      resources: null,
      environment: null,
      credentials: null,
      ttlHours: null,
      idleTimeoutMinutes: null,
    },
  });
  const context = await A2AContextModel.create({
    actorKind: "user",
    actorId: params.userId,
  });
  const task = await A2ATaskModel.create({
    contextId: context.id,
    agentId: agent.id,
    state: "TASK_STATE_WORKING",
  });
  const workloadName = `runtime-review-${task.id}`;
  await AgentRunModel.create({
    organizationId: params.organizationId,
    taskId: task.id,
    agentId: agent.id,
    actorKind: "user",
    actorId: params.userId,
    actorUserId: params.userId,
    workloadName,
    backend: "kubernetes",
    runtimeScope: "test",
  });
  await AgentWorkspaceModel.create({
    organizationId: params.organizationId,
    agentId: agent.id,
    actorKind: "user",
    actorId: params.userId,
    backend: "kubernetes",
    runtimeScope: "test",
    workloadName,
    state: "active",
    activeTaskId: task.id,
    lastTaskId: task.id,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return {
    taskId: task.id,
    organizationId: params.organizationId,
    session: {
      organization_id: params.organizationId,
      caller_id: `user:${params.userId}`,
      session_id: `user:${params.userId}|${workloadName}`,
    },
  };
}
