import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// The caller is a custom `project:admin` role (NOT a `scheduledTask:admin`) — the
// only way to exercise the distinct project-admin schedule branch, since an org
// admin would short-circuit on scheduledTask:admin and get full schedule access.
// No session header is set, so the header-based scheduledTask:admin check
// resolves false on its own; userHasPermission reads the role from the DB.
describe("schedule trigger routes — project admin oversight", () => {
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

  test("project admin can read, edit, enable, disable, and delete an existing project trigger", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${triggerId}`,
    });
    expect(read.statusCode).toBe(200);

    const edit = await app.inject({
      method: "PUT",
      url: `/api/schedule-triggers/${triggerId}`,
      payload: { name: "renamed-by-admin" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json<{ name: string }>().name).toBe("renamed-by-admin");

    const disable = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/disable`,
    });
    expect(disable.statusCode).toBe(200);
    const enable = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/enable`,
    });
    expect(enable.statusCode).toBe(200);

    // Delete shares the same authorization seam as enable/disable; assert the
    // admin is authorized (not 403) and the trigger is actually removed. (The
    // route's rowCount-based 200/404 is unreliable under PGlite, so verify the
    // effect via a follow-up read rather than the delete's own status.)
    const del = await app.inject({
      method: "DELETE",
      url: `/api/schedule-triggers/${triggerId}`,
    });
    expect(del.statusCode).not.toBe(403);
    const afterDelete = await app.inject({
      method: "GET",
      url: `/api/schedule-triggers/${triggerId}`,
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  test("project admin cannot run-now or create schedules", async () => {
    const runNow = await app.inject({
      method: "POST",
      url: `/api/schedule-triggers/${triggerId}/run-now`,
    });
    expect(runNow.statusCode).toBe(403);

    const create = await app.inject({
      method: "POST",
      url: "/api/schedule-triggers",
      payload: {
        name: "admin-made",
        agentId,
        projectId,
        cronExpression: "0 0 * * *",
        timezone: "UTC",
        messageTemplate: "hello",
      },
    });
    expect(create.statusCode).toBeGreaterThanOrEqual(400);
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
