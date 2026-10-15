import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ScheduleTriggerRunModel } from "@/models";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { shareForTest } from "@/test/sharing";
import type { User } from "@/types";

/**
 * GET /api/schedule-triggers/:id/runs — project-member access.
 *
 * A user who is a member of the project a schedule belongs to (but is NOT the
 * trigger's actorUserId and does NOT have project:admin) must be able to
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

  test("a project member (not the actor, no project:admin) can list runs of a project schedule", async ({
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
    });
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "member-run-history-project",
      description: null,
    });
    // Share the project with the whole org so actingUser can access it.
    await shareForTest({
      resource: "project",
      scope: project.id,
      organizationId,
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

    // actingUser is NOT the actor/owner and has no project:admin.
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

  test("blocking metadata survives serialization and stays behind the existing run access gate", async ({
    makeAgent,
    makeScheduleTrigger,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: actingUser.id });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: actingUser.id,
      agentId: agent.id,
    });
    const blockedBy = {
      phase: "running" as const,
      runId: "16100000-0000-4000-8000-000000000001",
      runtimeTaskId: "16100000-0000-4000-8000-000000000002",
      startedAt: "2026-10-15T10:00:00.000Z",
      elapsedSeconds: 7200,
      deadline: "2026-10-15T14:00:00.000Z",
      maximumDurationSeconds: 14400,
    };
    const skipped = await ScheduleTriggerRunModel.recordDueRun({
      trigger,
      now: new Date(),
      skip: {
        blockedBy,
        error: "Skipped: the earlier runtime run is unfinished",
      },
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}/runs`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0]).toMatchObject({
      id: skipped?.id,
      blockedBy,
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${trigger.id}/runs/${skipped?.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().blockedBy).toEqual(blockedBy);
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/schedule-triggers/${trigger.id}/runs`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/schedule-triggers/${trigger.id}/runs/${skipped?.id}`,
        })
      ).statusCode,
    ).toBe(403);
  });
});
