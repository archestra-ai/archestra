import {
  ADMIN_ROLE_NAME,
  BUILT_IN_AGENT_IDS,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import AuditLogModel from "@/models/audit-log";
import ScheduleTriggerModel from "@/models/schedule-trigger";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { drainBackgroundWork } from "@/utils/background-work";
import tunerRoutes from "./tuner.routes";

describe("PUT /api/tuners/:kind", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    config.tuners.enabled = true;
    config.openappa.enabled = true;
    config.sreAgent.enabled = false;
    organizationId = (await makeOrganization()).id;
    adminId = (await makeUser()).id;
    await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
    agentId = (
      await makeAgent({
        agentType: "agent",
        organizationId,
        builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
      })
    ).id;
    app = await authenticatedRouteApp({
      organizationId,
      routes: [tunerRoutes],
      auditLog: true,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const configure = (
    kind: string,
    payload: { enabled: boolean; cronExpression?: string; timezone?: string },
    userId = adminId,
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/tuners/${kind}`,
      headers: { [USER_HEADER]: userId },
      payload,
    });

  const tunerTriggers = () =>
    ScheduleTriggerModel.findTunerTriggers(organizationId);

  test("enabling creates the tuner's trigger on the default schedule, run as the caller, and audits it", async () => {
    const response = await configure("appa", { enabled: true });

    expect(response.statusCode, response.body).toBe(200);
    const [trigger, ...rest] = await tunerTriggers();
    expect(rest).toEqual([]);
    expect(trigger).toMatchObject({
      tunerKind: "appa",
      agentId,
      actorUserId: adminId,
      enabled: true,
      cronExpression: "0 6 * * *",
      timezone: "UTC",
    });
    expect(
      response
        .json()
        .find((summary: { kind: string }) => summary.kind === "appa"),
    ).toMatchObject({ trigger: { id: trigger.id, actor: { id: adminId } } });

    await drainBackgroundWork();
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: "appa",
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual([
      expect.objectContaining({
        action: "tuner.updated",
        outcome: "success",
        resourceType: "tuner",
        actorId: adminId,
        before: null,
        after: expect.objectContaining({ id: trigger.id, enabled: true }),
      }),
    ]);
  });

  test("a second call updates the one trigger; enabling moves the actor, disabling keeps the trigger and actor", async ({
    makeUser,
    makeMember,
  }) => {
    const secondAdmin = (await makeUser()).id;
    await makeMember(secondAdmin, organizationId, { role: ADMIN_ROLE_NAME });
    expect((await configure("appa", { enabled: true })).statusCode).toBe(200);
    const [created] = await tunerTriggers();

    const rescheduled = await configure(
      "appa",
      {
        enabled: true,
        cronExpression: "30 2 * * 1",
        timezone: "Europe/Warsaw",
      },
      secondAdmin,
    );
    expect(rescheduled.statusCode, rescheduled.body).toBe(200);
    expect(await tunerTriggers()).toEqual([
      expect.objectContaining({
        id: created.id,
        actorUserId: secondAdmin,
        cronExpression: "30 2 * * 1",
        timezone: "Europe/Warsaw",
        enabled: true,
      }),
    ]);

    const disabled = await configure("appa", { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(await tunerTriggers()).toEqual([
      expect.objectContaining({
        id: created.id,
        actorUserId: secondAdmin,
        cronExpression: "30 2 * * 1",
        enabled: false,
      }),
    ]);
  });

  test("enabling a tuner this deployment cannot run conflicts and creates nothing", async () => {
    const response = await configure("sre", { enabled: true });
    expect(response.statusCode, response.body).toBe(409);
    expect(await tunerTriggers()).toEqual([]);
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await configure("appa", { enabled: true })).statusCode).toBe(404);
    expect(await tunerTriggers()).toEqual([]);
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
      expect(
        (await configure("appa", { enabled: true }, userId)).statusCode,
      ).toBe(403);
    }
    expect(await tunerTriggers()).toEqual([]);

    const manager = await userWithRole(
      await customRole({ tuner: ["read", "update"], log: ["read", "admin"] }),
    );
    expect(
      (await configure("appa", { enabled: true }, manager)).statusCode,
    ).toBe(200);
  });
});
