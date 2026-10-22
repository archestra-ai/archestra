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
      groupChatFileSignIn: false,
      signInRedirectUri: expect.stringMatching(
        /\/api\/webhooks\/chatops\/ms-teams\/sign-in\/callback$/,
      ),
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
      enabled: true,
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
      groupChatFileSignIn: false,
      signInRedirectUri: expect.any(String),
    });
    expect(telegram.json()).toEqual({
      configured: true,
      updatedAt: expect.any(String),
      enabled: true,
    });
    for (const response of [slack, teams, telegram])
      for (const secret of SECRETS) expect(response.body).not.toContain(secret);
  });

  test.each([
    {
      connectionMode: "socket",
      appLevelToken: "xapp",
      signingSecret: "",
      configured: true,
    },
    {
      connectionMode: "socket",
      appLevelToken: "",
      signingSecret: "secret",
      configured: false,
    },
    {
      connectionMode: "webhook",
      appLevelToken: "",
      signingSecret: "secret",
      configured: true,
    },
    {
      connectionMode: "webhook",
      appLevelToken: "xapp",
      signingSecret: "",
      configured: false,
    },
  ] as const)("Slack in $connectionMode mode is configured only with the token that mode needs", async ({
    connectionMode,
    appLevelToken,
    signingSecret,
    configured,
  }) => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: true,
      botToken: "xoxb",
      signingSecret,
      appId: "A0SLACKAPP",
      connectionMode,
      appLevelToken,
    });

    expect((await get("slack")).json()).toMatchObject({
      configured,
      connectionMode,
    });
  });

  test("a disabled or incomplete config is stored but not configured", async () => {
    await ChatOpsConfigModel.saveSlackConfig({
      enabled: false,
      botToken: "xoxb",
      signingSecret: "secret",
      appId: "A0SLACKAPP",
      connectionMode: "webhook",
    });
    await ChatOpsConfigModel.saveMsTeamsConfig({
      enabled: true,
      appId: "teams-app-id",
      appSecret: "",
      tenantId: "",
      graphTenantId: "",
      graphClientId: "teams-app-id",
      graphClientSecret: "",
    });
    await ChatOpsConfigModel.saveTelegramConfig({
      enabled: false,
      botToken: "123:abc",
    });

    for (const provider of ["slack", "ms-teams", "telegram"])
      expect((await get(provider)).json()).toMatchObject({
        configured: false,
        updatedAt: expect.any(String),
      });
  });

  test("an organization settings reader can read config but still cannot write it", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const reader = await makeCustomRole(organizationId, {
      permission: { organizationSettings: ["read"] },
    });
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: reader.role });

    for (const provider of ["slack", "ms-teams", "telegram"]) {
      expect((await get(provider)).statusCode).toBe(200);
      const write = await app.inject({
        method: "PUT",
        url: `/api/chatops/config/${provider}`,
        payload: { enabled: false },
      });
      expect(write.statusCode).toBe(403);
    }
  });
});
