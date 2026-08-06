import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { AgentModel, ProjectModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Agents soft-delete, so `projects.default_agent_id`'s `ON DELETE SET NULL`
 * never fires. Deleting the agent has to unpin it explicitly, or restoring the
 * agent silently re-pins projects whose owners were shown "no default".
 */
describe("DELETE /api/agents/:id — projects pinning the agent", () => {
  let app: FastifyInstanceWithZod;
  let admin: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: admin, organizationId });
    });
    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("unpins the agent, so restoring it does not re-pin the project", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({ organizationId, scope: "org" });
    const project = await projectService.create({
      organizationId,
      userId: admin.id,
      name: "pinned-then-deleted",
      description: null,
      defaultAgentId: agent.id,
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agent.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();

    await AgentModel.restore(agent.id);
    expect(
      (await ProjectModel.findById(project.id))?.defaultAgentId,
    ).toBeNull();
  });

  test("leaves other projects' pins alone", async ({ makeInternalAgent }) => {
    const doomed = await makeInternalAgent({ organizationId, scope: "org" });
    const keeper = await makeInternalAgent({ organizationId, scope: "org" });
    const other = await projectService.create({
      organizationId,
      userId: admin.id,
      name: "unrelated-pin",
      description: null,
      defaultAgentId: keeper.id,
    });

    await app.inject({ method: "DELETE", url: `/api/agents/${doomed.id}` });

    expect((await ProjectModel.findById(other.id))?.defaultAgentId).toBe(
      keeper.id,
    );
  });
});
