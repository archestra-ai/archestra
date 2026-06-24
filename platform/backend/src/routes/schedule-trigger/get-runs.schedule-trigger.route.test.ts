import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * GET /api/schedule-triggers/:id/runs — project-member access.
 *
 * A user who is a member of the project a schedule belongs to (but is NOT the
 * trigger's actorUserId and does NOT have scheduledTask:admin) must be able to
 * list that schedule's runs. This covers the project run-history UX.
 */
describe("GET /api/schedule-triggers/:id/runs — project member access", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;

    // Default acting user for each test; individual tests may swap this.
    actingUser = await makeUser();
    await makeMember(actingUser.id, organizationId, {});

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = actingUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: scheduleTriggerRoutes } = await import(
      "../schedule-trigger"
    );
    await app.register(scheduleTriggerRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a project member (not the actor, no scheduledTask:admin) can list runs of a project schedule", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    // Set up: owner creates a project and a schedule in that project.
    const owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "member-run-history-project",
      description: null,
    });
    // Share the project with the whole org so actingUser can access it.
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
      projectId: project.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, { organizationId });

    // actingUser is NOT the actor/owner and has no scheduledTask:admin.
    const response = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}/runs`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe(run.id);
  });

  test("a user who is NOT a member of the project and not the actor gets 403", async ({
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
  }) => {
    // outsider is a member of the org but NOT a member of the project.
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId, {});

    const owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
    const agent = await makeAgent({
      organizationId,
      authorId: owner.id,
      scope: "org",
    });
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "private-project",
      description: null,
    });
    // No share → project is owner-only.
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      agentId: agent.id,
      projectId: project.id,
    });

    actingUser = outsider;
    const response = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}/runs`,
    });

    expect(response.statusCode).toBe(403);
  });

  test("the trigger actor (owner) can always list their own runs", async ({
    makeAgent,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    // actingUser is the actorUserId — the existing owner path.
    const agent = await makeAgent({
      organizationId,
      authorId: actingUser.id,
      scope: "org",
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: actingUser.id,
      agentId: agent.id,
    });
    const run = await makeScheduleTriggerRun(trigger.id, { organizationId });

    const response = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}/runs`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].id).toBe(run.id);
  });
});
