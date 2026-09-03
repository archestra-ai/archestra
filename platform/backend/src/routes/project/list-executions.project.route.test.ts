import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";

type ExecutionItem = {
  taskId: string;
  actorUserId: string;
  viewerRole: "owner" | "shared";
};

describe("GET /api/projects/:id/executions (project:read-all)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let agent: Agent;
  let owner: User;
  let viewer: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser({ email: "owner@test.com" });
    await makeMember(owner.id, organizationId, {});
    viewer = await makeUser({ email: "viewer@test.com" });
    await makeMember(viewer.id, organizationId, {});
    agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      name: "Execution Agent",
      teams: [],
    });
    actingUser = viewer;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a member without read-all sees only executions they started", async () => {
    const { project, viewerExecution } = await seedProjectWithTwoExecutions();
    actingUser = viewer;

    const response = await listExecutions(project.id);

    expect(response.statusCode).toBe(200);
    expect(response.json<ExecutionItem[]>()).toEqual([
      expect.objectContaining({
        taskId: viewerExecution.taskId,
        actorUserId: viewer.id,
        viewerRole: "owner",
      }),
    ]);
  });

  test("an admin sees all project executions read-only", async ({
    makeUser,
    makeMember,
  }) => {
    const admin = await makeUser({ email: "admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    const { project, ownerExecution, viewerExecution } =
      await seedProjectWithTwoExecutions();
    actingUser = admin;

    const response = await listExecutions(project.id);

    expect(response.statusCode).toBe(200);
    expect(response.json<ExecutionItem[]>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          taskId: ownerExecution.taskId,
          viewerRole: "shared",
        }),
        expect.objectContaining({
          taskId: viewerExecution.taskId,
          viewerRole: "shared",
        }),
      ]),
    );
  });

  test("a custom project read-all role sees every execution", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { project: ["read", "read-all"] },
    });
    const reader = await makeUser({ email: "reader@test.com" });
    await makeMember(reader.id, organizationId, { role: role.role });
    const { project, ownerExecution, viewerExecution } =
      await seedProjectWithTwoExecutions();
    actingUser = reader;

    const response = await listExecutions(project.id);

    expect(response.statusCode).toBe(200);
    expect(
      response
        .json<ExecutionItem[]>()
        .map((execution) => execution.taskId)
        .sort(),
    ).toEqual([ownerExecution.taskId, viewerExecution.taskId].sort());
  });

  async function seedProjectWithTwoExecutions() {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "Shared execution project",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const ownerExecution = await createExecution(owner.id, project.id);
    const viewerExecution = await createExecution(viewer.id, project.id);
    return { project, ownerExecution, viewerExecution };
  }

  async function createExecution(actorUserId: string, projectId: string) {
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: actorUserId,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_SUBMITTED",
    });
    return await AgentRunModel.create({
      organizationId,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: actorUserId,
      actorUserId,
      projectId,
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
  }

  const listExecutions = (projectId: string) =>
    app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/executions`,
    });
});
