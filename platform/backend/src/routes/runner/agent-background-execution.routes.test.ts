import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

vi.mock("@/observability");

describe("Agent Background execution routes", () => {
  let app: FastifyInstanceWithZod;
  let agent: Agent;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAgent, makeAdmin, makeMember, makeOrganization }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });
    agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
      backgroundExecution: {
        image: "example.com/coding-agent:latest",
        command: null,
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: [
          {
            key: "SHARED_TOKEN",
            scope: "shared",
            label: "Shared token",
            required: true,
          },
          {
            key: "PERSONAL_TOKEN",
            scope: "per_user",
            label: "Personal token",
            required: true,
          },
        ],
        ttlHours: null,
        idleTimeoutMinutes: null,
      },
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./runner.routes");
    await app.register(routes);
    vi.spyOn(runnerRuntimeManager, "isEnabled", "get").mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("lists only runs belonging to the selected Agent", async ({
    makeAgent,
  }) => {
    const otherAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    const selectedTask = await createTask(agent.id);
    const otherTask = await createTask(otherAgent.id);
    await AgentRunModel.create({
      organizationId,
      taskId: selectedTask.id,
      agentId: agent.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${selectedTask.id}`,
      namespace: "archestra-dev",
      secretName: null,
      virtualApiKeyId: null,
    });
    await AgentRunModel.create({
      organizationId,
      taskId: otherTask.id,
      agentId: otherAgent.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${otherTask.id}`,
      namespace: "archestra-dev",
      secretName: null,
      virtualApiKeyId: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/runs`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        taskId: selectedTask.id,
        agentId: agent.id,
      }),
    ]);
  });

  test("preflight distinguishes missing personal credentials from missing shared configuration", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/background-execution/preflight`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ready: false,
      configured: [],
      missing: [
        expect.objectContaining({
          key: "PERSONAL_TOKEN",
          label: "Personal token",
        }),
      ],
      misconfigured: [
        expect.objectContaining({
          key: "SHARED_TOKEN",
          label: "Shared token",
        }),
      ],
    });
  });

  test("lets a reader manage only their own personal credential", async ({
    makeMember,
    makeUser,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const personal = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/PERSONAL_TOKEN`,
      payload: { value: "personal-value" },
    });
    const shared = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/SHARED_TOKEN`,
      payload: { value: "shared-value" },
    });

    expect(personal.statusCode).toBe(200);
    expect(shared.statusCode).toBe(403);
    const preflight = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/background-execution/preflight`,
    });
    expect(preflight.json().configured).toEqual(["PERSONAL_TOKEN"]);
  });

  test("audits shared credential rotation without recording the secret value", async () => {
    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/SHARED_TOKEN`,
      payload: { value: "never-log-this-value" },
    });

    expect(response.statusCode).toBe(200);
    const [audit] = await db
      .select({
        action: schema.auditLogsTable.action,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );
    expect(audit).toMatchObject({
      action: "agent.updated",
      resourceId: agent.id,
      before: expect.any(Object),
      after: expect.any(Object),
    });
    expect(JSON.stringify(audit)).not.toContain("never-log-this-value");
    expect(audit.before).not.toEqual(audit.after);
  });

  async function createTask(agentId: string) {
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: user.id,
    });
    return await A2ATaskModel.create({
      contextId: context.id,
      agentId,
      state: "TASK_STATE_SUBMITTED",
    });
  }
});
