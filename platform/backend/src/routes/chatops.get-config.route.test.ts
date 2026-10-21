import { ADMIN_ROLE_NAME } from "@archestra/shared";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { ChatOpsConfigModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import chatopsRoutes from "./chatops";

const SECRETS = [
  "xoxb-bot-token-under-test",
  "signing-secret-under-test",
  "xapp-app-level-token-under-test",
  "oauth-client-secret-under-test",
  "teams-app-secret-under-test",
  "123456:telegram-token-under-test",
];

describe("GET /api/chatops/config/:provider", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let actor: User;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: actor, organizationId });
    });
    registerRoutePermissions(app);
    await app.register(chatopsRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  const get = (provider: string) =>
    app.inject({ method: "GET", url: `/api/chatops/config/${provider}` });

  test("reports nothing configured before any config is stored", async () => {
    expect((await get("slack")).json()).toEqual({
      configured: false,
      updatedAt: null,
      enabled: false,
      appId: null,
      connectionMode: "socket",
    });
    expect((await get("ms-teams")).json()).toEqual({
      configured: false,
      updatedAt: null,
      enabled: false,
      appId: null,
      tenantId: null,
    });
    expect((await get("telegram")).json()).toEqual({
      configured: false,
      updatedAt: null,
      enabled: false,
    });
  });

  test("returns stored identifiers and never a secret", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: SECRETS[0],
      signingSecret: SECRETS[1],
      appId: "A0SLACKAPP",
      connectionMode: "webhook",
      appLevelToken: SECRETS[2],
      clientId: "client-id",
      clientSecret: SECRETS[3],
    });
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "teams-app-id",
      appSecret: SECRETS[4],
      tenantId: "teams-tenant-id",
      graphTenantId: "teams-tenant-id",
      graphClientId: "teams-app-id",
      graphClientSecret: SECRETS[4],
    });
    await ChatOpsConfigModel.saveTelegramConfig({
      enabled: false,
      botToken: SECRETS[5],
    });

    const slack = await get("slack");
    const teams = await get("ms-teams");
    const telegram = await get("telegram");

    expect(slack.statusCode, slack.body).toBe(200);
    expect(slack.json()).toEqual({
      configured: true,
      updatedAt: expect.any(String),
      enabled: true,
      appId: "A0SLACKAPP",
      connectionMode: "webhook",
    });
    expect(teams.json()).toEqual({
      configured: true,
      updatedAt: expect.any(String),
      enabled: true,
      appId: "teams-app-id",
      tenantId: "teams-tenant-id",
    });
    expect(telegram.json()).toEqual({
      configured: true,
      updatedAt: expect.any(String),
      enabled: false,
    });
    for (const response of [slack, teams, telegram])
      for (const secret of SECRETS) expect(response.body).not.toContain(secret);
  });

  test("takes the same organization settings update permission as the write", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const reader = await makeCustomRole(organizationId, {
      permission: { organizationSettings: ["read"] },
    });
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: reader.role });

    for (const provider of ["slack", "ms-teams", "telegram"])
      expect((await get(provider)).statusCode).toBe(403);
  });
});
