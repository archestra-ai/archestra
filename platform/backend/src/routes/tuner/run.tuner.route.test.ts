import {
  ADMIN_ROLE_NAME,
  BUILT_IN_AGENT_IDS,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { drainBackgroundWork } from "@/utils/background-work";
import tunerRoutes from "./tuner.routes";

describe("POST /api/tuners/:kind/run", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  let triggerId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeScheduleTrigger,
    }) => {
      config.tuners.enabled = true;
      config.openappa.enabled = true;
      config.sreAgent.enabled = false;
      organizationId = (await makeOrganization()).id;
      adminId = (await makeUser()).id;
      await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
      const agent = await makeAgent({
        agentType: "agent",
        organizationId,
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
      });
      triggerId = (
        await makeScheduleTrigger({
          organizationId,
          actorUserId: adminId,
          agentId: agent.id,
          tunerKind: "appa",
        })
      ).id;
      app = await authenticatedRouteApp({
        organizationId,
        routes: [tunerRoutes],
        auditLog: true,
      });
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const run = (kind: string, userId = adminId) =>
    app.inject({
      method: "POST",
      url: `/api/tuners/${kind}/run`,
      headers: { [USER_HEADER]: userId },
    });

  const runsOfTrigger = () =>
    ScheduleTriggerRunModel.findLatestByTriggerIds([triggerId]);

  test("queues a manual run initiated by the caller and audits it", async () => {
    const response = await run("appa");

    expect(response.statusCode, response.body).toBe(202);
    expect(
      await ScheduleTriggerRunModel.findById(response.json().id),
    ).toMatchObject({
      triggerId,
      organizationId,
      runKind: "manual",
      initiatedByUserId: adminId,
    });

    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: "appa",
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual([
      expect.objectContaining({
        action: "tuner.run",
        outcome: "success",
        resourceType: "tuner",
        actorId: adminId,
      }),
    ]);
  });

  test("concurrent requests start one run, and none while it is running", async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => run("appa")),
    );

    expect(responses.map((r) => r.statusCode).sort()).toEqual([
      202, 409, 409, 409, 409,
    ]);
    expect(
      await ScheduleTriggerRunModel.countByTrigger({
        organizationId,
        triggerId,
      }),
    ).toBe(1);

    const [started] = responses.filter((r) => r.statusCode === 202);
    await ScheduleTriggerRunModel.markCompleted({
      runId: started.json().id,
      status: "success",
    });
    expect((await run("appa")).statusCode).toBe(202);
  });

  test("a tuner without a trigger is not found", async () => {
    expect((await run("sre")).statusCode).toBe(404);
  });

  test("a configured tuner that became unavailable conflicts and starts no run", async () => {
    config.openappa.enabled = false;
    expect((await run("appa")).statusCode).toBe(409);
    expect(await runsOfTrigger()).toEqual([]);
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await run("appa")).statusCode).toBe(404);
    expect(await runsOfTrigger()).toEqual([]);
  });

  test("refuses members and roles missing tuner:update or log:admin", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const userWithRole = async (role: string) => {
      const user = await makeUser();
      await makeMember(user.id, organizationId, { role });
      return user.id;
    };
    const customRole = async (permission: Record<string, string[]>) =>
      (await makeCustomRole(organizationId, { permission })).role;

    const denied = [
      await userWithRole(MEMBER_ROLE_NAME),
      await userWithRole(EDITOR_ROLE_NAME),
      await userWithRole(
        await customRole({ tuner: ["read"], log: ["read", "admin"] }),
      ),
      await userWithRole(await customRole({ tuner: ["read", "update"] })),
    ];
    for (const userId of denied) {
      expect((await run("appa", userId)).statusCode).toBe(403);
    }
    expect(await runsOfTrigger()).toEqual([]);
  });
});
