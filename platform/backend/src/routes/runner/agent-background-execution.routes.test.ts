import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { A2AProtocolRole } from "@/agents/a2a/a2a-protocol";
import config from "@/config";
import db, { schema } from "@/database";
import { runnerRuntimeManager } from "@/k8s/runner-runtime";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  A2AContextModel,
  A2AMessageModel,
  A2ATaskModel,
  AgentRunModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { createExecutionCredentialDefinition } from "@/services/runners/execution-credentials";
import {
  cancelDetachedAgentTask,
  startDetachedAgentTask,
} from "@/services/runners/start-task";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

vi.mock("@/observability");
vi.mock("@/services/runners/start-task", () => ({
  cancelDetachedAgentTask: vi.fn(),
  startDetachedAgentTask: vi.fn(),
}));

describe("Agent Background execution routes", () => {
  let app: FastifyInstanceWithZod;
  let agent: Agent;
  let user: User;
  let organizationId: string;
  let previousFeatureEnabled: boolean;
  let previousClusterReachable: unknown;

  beforeEach(async ({ makeAgent, makeAdmin, makeMember, makeOrganization }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });
    await createExecutionCredentialDefinition({
      organizationId,
      userId: user.id,
      definition: {
        key: "shared-token",
        name: "Shared token",
        description: "Organization credential for delegated work",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    agent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
      backgroundExecution: {
        image: "example.com/coding-agent:latest",
        command: null,
        inferenceProtocol: "openai_responses",
        backend: "kubernetes",
        steerMode: "pipe",
        privileged: false,
        resources: null,
        environment: null,
        credentials: [
          {
            key: "SHARED_TOKEN",
            credentialId: "shared-token",
            scope: "shared",
            label: "Shared token",
            required: true,
          },
          {
            key: "PERSONAL_TOKEN",
            credentialId: "github",
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
    previousFeatureEnabled = config.agentBackgroundExecution.enabled;
    previousClusterReachable = Reflect.get(
      runnerRuntimeManager,
      "clusterReachable",
    );
    config.agentBackgroundExecution.enabled = true;
    Reflect.set(runnerRuntimeManager, "clusterReachable", true);
  });

  afterEach(async () => {
    config.agentBackgroundExecution.enabled = previousFeatureEnabled;
    Reflect.set(
      runnerRuntimeManager,
      "clusterReachable",
      previousClusterReachable,
    );
    vi.restoreAllMocks();
    await app.close();
  });

  test("lists only executions belonging to the selected Agent with their task outcome", async ({
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
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${selectedTask.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await A2ATaskModel.transitionStateWithEvent({
      id: selectedTask.id,
      to: "TASK_STATE_FAILED",
      allowedFrom: ["TASK_STATE_SUBMITTED"],
      statusReason: "The execution process exited with status 1",
      eventPayload: {
        statusUpdate: {
          taskId: selectedTask.id,
          contextId: selectedTask.contextId,
          status: {
            state: "TASK_STATE_FAILED",
            message: {
              messageId: crypto.randomUUID(),
              role: A2AProtocolRole.Agent,
              parts: [{ text: "The execution process exited with status 1" }],
            },
          },
          final: true,
        },
      },
    });
    await AgentRunModel.create({
      organizationId,
      taskId: otherTask.id,
      agentId: otherAgent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${otherTask.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/executions`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        taskId: selectedTask.id,
        agentId: agent.id,
        state: "TASK_STATE_FAILED",
        statusReason: "The execution process exited with status 1",
      }),
    ]);
  });

  test("keeps every execution endpoint unavailable when no execution backend is enabled", async () => {
    config.agentBackgroundExecution.enabled = false;

    const response = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/executions`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("starts a durable execution as the signed-in user", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/SHARED_TOKEN`,
      payload: { value: "shared-value" },
    });
    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/PERSONAL_TOKEN`,
      payload: { value: "personal-value" },
    });
    const task = await createTask(agent.id);
    vi.mocked(startDetachedAgentTask).mockResolvedValue(task);

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${agent.id}/executions`,
      payload: {
        message: "Implement the requested change.",
        systemParams: expect.objectContaining({
          source: "chat",
          backgroundExecutionMode: "interactive",
        }),
        attachments: [
          {
            name: "requirements.txt",
            contentType: "text/plain",
            contentBase64: Buffer.from("fastify").toString("base64"),
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      taskId: task.id,
      agentId: agent.id,
      agentName: agent.name,
      prompt: "Implement the requested change.",
      state: "TASK_STATE_SUBMITTED",
    });
    expect(startDetachedAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: {
          id: user.id,
          kind: "user",
          organizationId,
        },
        agentId: agent.id,
        message: "Implement the requested change.",
        attachments: [
          {
            name: "requirements.txt",
            contentType: "text/plain",
            contentBase64: Buffer.from("fastify").toString("base64"),
          },
        ],
      }),
    );
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
          eq(schema.auditLogsTable.action, "agentExecution.created"),
          eq(schema.auditLogsTable.resourceId, task.id),
        ),
      );
    expect(audit).toMatchObject({
      action: "agentExecution.created",
      resourceId: task.id,
      before: null,
      after: {
        taskId: task.id,
        agentId: agent.id,
        state: "TASK_STATE_SUBMITTED",
        attachmentCount: 1,
      },
    });
    expect(JSON.stringify(audit)).not.toContain(
      "Implement the requested change",
    );
    expect(JSON.stringify(audit)).not.toContain("requirements.txt");
  });

  test("lists only the current user's execution sessions with their prompt", async ({
    makeAdmin,
    makeMember,
  }) => {
    const ownTask = await createTask(agent.id);
    await A2AMessageModel.create({
      contextId: ownTask.contextId,
      taskId: ownTask.id,
      role: A2AProtocolRole.User,
      parts: [{ text: "Create a compact status page." }],
      content: {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: "Create a compact status page." }],
      },
    });
    await AgentRunModel.create({
      organizationId,
      taskId: ownTask.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${ownTask.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });

    const colleague = await makeAdmin();
    await makeMember(colleague.id, organizationId, { role: "admin" });
    const colleagueTask = await createTask(agent.id);
    await AgentRunModel.create({
      organizationId,
      taskId: colleagueTask.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: colleague.id,
      actorUserId: colleague.id,
      deploymentName: `agent-run-${colleagueTask.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent-executions",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        taskId: ownTask.id,
        prompt: "Create a compact status page.",
        agent: {
          id: agent.id,
          name: agent.name,
          icon: agent.icon,
        },
      }),
    ]);
  });

  test("lets only the initiating user cancel an active execution and audits the transition", async ({
    makeAdmin,
    makeMember,
  }) => {
    const task = await createTask(agent.id);
    await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    vi.mocked(cancelDetachedAgentTask).mockResolvedValue({
      id: task.id,
      contextId: task.contextId,
      status: { state: "TASK_STATE_CANCELED" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/agent-executions/${task.id}/cancel`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      taskId: task.id,
      state: "TASK_STATE_CANCELED",
    });
    expect(cancelDetachedAgentTask).toHaveBeenCalledWith({
      actor: { id: user.id, kind: "user", organizationId },
      agentId: agent.id,
      taskId: task.id,
    });

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
          eq(schema.auditLogsTable.action, "agentExecution.canceled"),
          eq(schema.auditLogsTable.resourceId, task.id),
        ),
      );
    expect(audit).toEqual({
      action: "agentExecution.canceled",
      resourceId: task.id,
      before: {
        taskId: task.id,
        agentId: agent.id,
        state: "TASK_STATE_SUBMITTED",
      },
      after: {
        taskId: task.id,
        agentId: agent.id,
        state: "TASK_STATE_CANCELED",
      },
    });

    const otherUser = await makeAdmin();
    await makeMember(otherUser.id, organizationId, { role: "admin" });
    user = otherUser;
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/agent-executions/${task.id}/cancel`,
    });
    expect(forbidden.statusCode).toBe(404);
  });

  test("lets the initiating user rename and delete a finished execution", async () => {
    const task = await createTask(agent.id);
    const run = await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: user.id,
      actorUserId: user.id,
      title: "Opening request",
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/agent-executions/${task.id}`,
      payload: { title: "Concise session title" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe("Concise session title");

    const activeDelete = await app.inject({
      method: "DELETE",
      url: `/api/agent-executions/${task.id}`,
    });
    expect(activeDelete.statusCode).toBe(409);

    await AgentRunModel.close({ id: run.id });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agent-executions/${task.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(await A2ATaskModel.findById(task.id)).toBeNull();

    const audits = await db
      .select({
        action: schema.auditLogsTable.action,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, task.id));
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "agentExecution.updated",
          before: expect.objectContaining({ title: "Opening request" }),
          after: expect.objectContaining({ title: "Concise session title" }),
        }),
        expect.objectContaining({
          action: "agentExecution.deleted",
          before: expect.objectContaining({ title: "Concise session title" }),
          after: { deleted: true },
        }),
      ]),
    );
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

  test("reuses a typed personal connection across Agents without copying its value", async ({
    makeAgent,
  }) => {
    if (!agent.backgroundExecution) {
      throw new Error("Test Agent is missing Background execution");
    }
    const otherAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
      backgroundExecution: {
        ...agent.backgroundExecution,
        credentials: [
          {
            key: "GH_TOKEN",
            credentialId: "github",
            scope: "per_user",
            label: "Git hosting connection",
            required: true,
          },
        ],
      },
    });

    const connected = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/background-execution/credentials/PERSONAL_TOKEN`,
      payload: { value: "one-personal-value" },
    });
    expect(connected.statusCode).toBe(200);

    const otherPreflight = await app.inject({
      method: "GET",
      url: `/api/agents/${otherAgent.id}/background-execution/preflight`,
    });
    expect(otherPreflight.statusCode).toBe(200);
    expect(otherPreflight.json()).toMatchObject({
      ready: true,
      configured: ["GH_TOKEN"],
      missing: [],
    });

    const rows = await db
      .select({
        credentialId: schema.executionCredentialConnectionsTable.credentialId,
        userId: schema.executionCredentialConnectionsTable.userId,
      })
      .from(schema.executionCredentialConnectionsTable);
    expect(rows).toEqual([{ credentialId: "github", userId: user.id }]);
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
    expect(JSON.stringify(audit)).toContain('"credentialId":"shared-token"');
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
