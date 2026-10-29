// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("schedule trigger routes — Projects oversight", () => {
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
        permission: { project: ["read", "create", "update", "delete"] },
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

  async function grantProjectOversight(
    actions: ("read" | "use" | "update" | "delete" | "manage-permissions")[],
    scope = "*",
  ) {
    const key = { organizationId, resource: "project" as const, scope };
    const existing = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: existing?.revision ?? 0,
      grants: [
        ...(existing?.grants ?? []),
        {
          subject: { type: "user", id: projectAdmin.id },
          actions,
        },
      ],
    });
  }

  test("project oversight reads and manages another actor's schedule", async () => {
    await grantProjectOversight([
      "read",
      "use",
      "update",
      "delete",
      "manage-permissions",
    ]);
    for (const req of [
      { method: "GET" as const, url: `/api/schedule-triggers/${triggerId}` },
      {
        method: "GET" as const,
        url: `/api/schedule-triggers?projectId=${projectId}`,
      },
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
      const response = await app.inject(req);
      expect(response.statusCode, response.body).toBe(200);
    }
  });

  test("read-only project oversight cannot change or run another actor's schedule", async () => {
    await grantProjectOversight(["read"]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/schedule-triggers/${triggerId}`,
        })
      ).statusCode,
    ).toBe(200);
    for (const req of [
      {
        method: "PUT" as const,
        url: `/api/schedule-triggers/${triggerId}`,
        payload: { name: "forbidden" },
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
    ])
      expect((await app.inject(req)).statusCode).toBe(403);
  });

  test("full access on one shared project does not permit acting as its schedule owner", async () => {
    await grantProjectOversight(
      ["read", "use", "update", "delete", "manage-permissions"],
      projectId,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/schedule-triggers/${triggerId}`,
        })
      ).statusCode,
    ).toBe(200);
    for (const req of [
      {
        method: "PUT" as const,
        url: `/api/schedule-triggers/${triggerId}`,
        payload: { name: "forbidden" },
      },
      {
        method: "POST" as const,
        url: `/api/schedule-triggers/${triggerId}/run-now`,
      },
      { method: "DELETE" as const, url: `/api/schedule-triggers/${triggerId}` },
    ])
      expect((await app.inject(req)).statusCode).toBe(403);
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
