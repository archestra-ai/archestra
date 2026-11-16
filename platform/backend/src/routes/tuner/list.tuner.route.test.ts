import {
  ADMIN_ROLE_NAME,
  BUILT_IN_AGENT_IDS,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import tunerRoutes from "./tuner.routes";

describe("GET /api/tuners", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    config.tuners.enabled = true;
    config.openappa.enabled = true;
    config.sreAgent.enabled = false;
    organizationId = (await makeOrganization()).id;
    adminId = (await makeUser()).id;
    await makeMember(adminId, organizationId, { role: ADMIN_ROLE_NAME });
    app = await authenticatedRouteApp({
      organizationId,
      routes: [tunerRoutes],
    });
  });

  afterEach(async () => {
    await app.close();
  });

  const list = (userId = adminId) =>
    app.inject({
      method: "GET",
      url: "/api/tuners",
      headers: { [USER_HEADER]: userId },
    });

  test("reports availability, the tuner's trigger and its latest run, only for this organization", async ({
    makeAgent,
    makeOrganization,
    makeScheduleTrigger,
    makeScheduleTriggerRun,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      organizationId,
      builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.APPA_TUNER },
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: adminId,
      agentId: agent.id,
      tunerKind: "appa",
    });
    const run = await makeScheduleTriggerRun(trigger.id);
    const otherOrganization = await makeOrganization();
    await makeScheduleTrigger({
      organizationId: otherOrganization.id,
      tunerKind: "sre",
    });

    const response = await list();

    expect(response.statusCode, response.body).toBe(200);
    const byKind = Object.fromEntries(
      response
        .json()
        .map((summary: { kind: string }) => [summary.kind, summary]),
    );
    expect(byKind.appa).toMatchObject({
      available: true,
      trigger: { id: trigger.id, actor: { id: adminId } },
      lastRun: { id: run.id },
    });
    expect(byKind.sre).toMatchObject({
      available: false,
      trigger: null,
      lastRun: null,
    });
  });

  test("is not found while tuners are disabled", async () => {
    config.tuners.enabled = false;
    expect((await list()).statusCode).toBe(404);
  });

  test("refuses members and roles missing tuner:read or log:admin", async ({
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
      await userWithRole(await customRole({ tuner: ["read", "update"] })),
      await userWithRole(await customRole({ log: ["read", "admin"] })),
    ];
    for (const userId of denied) {
      expect((await list(userId)).statusCode).toBe(403);
    }
    const viewer = await userWithRole(
      await customRole({ tuner: ["read"], log: ["read", "admin"] }),
    );
    expect((await list(viewer)).statusCode).toBe(200);
  });
});
