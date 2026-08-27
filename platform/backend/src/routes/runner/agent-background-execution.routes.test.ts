import { vi } from "vitest";
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
        credentials: null,
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
    const { default: routes } = await import("./runner.routes");
    await app.register(routes);
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
      endedAt: null,
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
      endedAt: null,
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
