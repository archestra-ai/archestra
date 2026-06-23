import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Schedule oversight rides the existing `scheduledTask:admin` — there is NO
// separate `project:admin` schedule path. The caller here is a custom
// `project:admin` role (NOT `scheduledTask:admin`); with no session header the
// scheduledTask:admin check resolves false, so trigger-level ops must be denied.
describe("schedule trigger routes — project:admin has no schedule access", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let projectId: string;
  let triggerId: string;
  let agentId: string;
  let projectAdmin: User;
  let plainMember: User;
  let actingUser: User;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeAgent,
      makeScheduleTrigger,
    }) => {
      organizationId = (await makeOrganization()).id;

      const owner = await makeUser();
      await makeMember(owner.id, organizationId, {});
      agentId = (
        await makeAgent({
          organizationId,
          authorId: owner.id,
          scope: "org",
        })
      ).id;
      projectId = (
        await projectService.create({
          organizationId,
          userId: owner.id,
          name: "sched-oversight",
          description: null,
        })
      ).id;
      triggerId = (
        await makeScheduleTrigger({
          organizationId,
          actorUserId: owner.id,
          agentId,
          projectId,
        })
      ).id;

      const role = await makeCustomRole(organizationId, {
        permission: { project: ["read", "admin"] },
      });
      projectAdmin = await makeUser({ email: "sched-projadmin@test.com" });
      await makeMember(projectAdmin.id, organizationId, { role: role.role });

      plainMember = await makeUser({ email: "sched-plain@test.com" });
      await makeMember(plainMember.id, organizationId, {});

      actingUser = projectAdmin;
      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = actingUser;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      const { default: scheduleTriggerRoutes } = await import(
        "./schedule-trigger"
      );
      await app.register(scheduleTriggerRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("a project:admin (without scheduledTask:admin) cannot read or manage a project trigger", async () => {
    for (const req of [
      { method: "GET" as const, url: `/api/schedule-triggers/${triggerId}` },
      {
        method: "PUT" as const,
        url: `/api/schedule-triggers/${triggerId}`,
        payload: { name: "renamed-by-admin" },
      },
      {
        method: "POST" as const,
        url: `/api/schedule-triggers/${triggerId}/enable`,
      },
      {
        method: "POST" as const,
        url: `/api/schedule-triggers/${triggerId}/disable`,
      },
      {
        method: "POST" as const,
        url: `/api/schedule-triggers/${triggerId}/run-now`,
      },
      { method: "DELETE" as const, url: `/api/schedule-triggers/${triggerId}` },
    ]) {
      expect((await app.inject(req)).statusCode).toBe(403);
    }
  });

  test("a non-admin member cannot access another user's project trigger", async () => {
    actingUser = plainMember;
    const read = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${triggerId}`,
    });
    expect(read.statusCode).toBe(403);

    const edit = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${triggerId}`,
      payload: { name: "nope" },
    });
    expect(edit.statusCode).toBe(403);
  });
});
