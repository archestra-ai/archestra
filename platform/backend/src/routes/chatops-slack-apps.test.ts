import { vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import {
  ChatOpsBotModel,
  ChatOpsChannelBindingModel,
  ChatOpsConfigModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const { startSlackAppMock, stopSlackAppMock } = vi.hoisted(() => ({
  startSlackAppMock: vi.fn(),
  stopSlackAppMock: vi.fn(),
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: vi.fn(),
    startSlackApp: startSlackAppMock,
    stopSlackApp: stopSlackAppMock,
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => null),
  },
}));

// Each bot token resolves to its own bot user, like real Slack apps.
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    constructor(private readonly token?: string) {}
    auth = {
      test: () =>
        Promise.resolve({
          ok: true,
          user_id: `U-${this.token}`,
          team_id: "T-test",
        }),
    };
    apps = { connections: { open: () => Promise.resolve({ ok: true }) } };
  },
}));

describe("Slack Apps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createApp = async (organizationId: string) => {
    const app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    await app.register(chatopsRoutes);
    return app;
  };

  const socketCredentials = (botToken: string) => ({
    botToken,
    appLevelToken: "xapp-test",
    appId: "A-test",
    connectionMode: "socket" as const,
  });

  describe("POST /api/chatops/bots/slack", () => {
    test("creates another Slack App under the requested id and starts only that app", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      await makeChatOpsBot(organization.id, { name: "Archestra" });
      const app = await createApp(organization.id);
      const newBotId = crypto.randomUUID();

      const response = await app.inject({
        method: "POST",
        url: "/api/chatops/bots/slack",
        payload: {
          id: newBotId,
          name: "Clode",
          ...socketCredentials("xoxb-clode"),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id: newBotId, name: "Clode" });
      const bots = await ChatOpsBotModel.findByProvider({
        organizationId: organization.id,
        provider: "slack",
      });
      expect(bots.map((bot) => bot.name)).toEqual(["Archestra", "Clode"]);
      const created = bots.find((bot) => bot.id === newBotId);
      if (!created) throw new Error("the new Slack App was not created");
      expect(await ChatOpsConfigModel.getSlackConfig(created)).toMatchObject({
        enabled: true,
        botToken: "xoxb-clode",
        connectionMode: "socket",
      });
      expect(startSlackAppMock).toHaveBeenCalledTimes(1);
      expect(startSlackAppMock).toHaveBeenCalledWith(newBotId);

      await app.close();
    });

    test("refuses a bot token another Slack App already uses", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      await makeChatOpsBot(organization.id, {
        name: "Archestra",
        externalWorkspaceId: "T-test",
        externalBotUserId: "U-xoxb-archestra",
      });
      const app = await createApp(organization.id);

      const response = await app.inject({
        method: "POST",
        url: "/api/chatops/bots/slack",
        payload: { name: "Clode", ...socketCredentials("xoxb-archestra") },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        'already used by the Slack App "Archestra"',
      );
      expect(
        await ChatOpsBotModel.findByProvider({
          organizationId: organization.id,
          provider: "slack",
        }),
      ).toHaveLength(1);
      expect(startSlackAppMock).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe("identity pin on reconfigure", () => {
    const pinnedBot = async (
      makeOrganization: () => Promise<{ id: string }>,
      makeChatOpsBot: (
        organizationId: string,
        overrides: Record<string, unknown>,
      ) => Promise<{ id: string }>,
    ) => {
      const organization = await makeOrganization();
      const bot = await makeChatOpsBot(organization.id, {
        name: "Clode",
        externalWorkspaceId: "T-test",
        externalBotUserId: "U-xoxb-clode",
      });
      return { organization, bot };
    };

    test("accepts a rotated token that resolves to the same bot", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const { organization, bot } = await pinnedBot(
        makeOrganization,
        makeChatOpsBot,
      );
      const app = await createApp(organization.id);

      // The mock derives the bot user from the token, so "rotating" to a
      // different string would look like another app; re-saving the same
      // token is the same-identity case.
      const response = await app.inject({
        method: "PUT",
        url: "/api/chatops/config/slack",
        payload: {
          botId: bot.id,
          enabled: true,
          ...socketCredentials("xoxb-clode"),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(startSlackAppMock).toHaveBeenCalledWith(bot.id);

      await app.close();
    });

    test("refuses a token for a different Slack app", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const { organization, bot } = await pinnedBot(
        makeOrganization,
        makeChatOpsBot,
      );
      const app = await createApp(organization.id);

      const response = await app.inject({
        method: "PUT",
        url: "/api/chatops/config/slack",
        payload: {
          botId: bot.id,
          enabled: true,
          ...socketCredentials("xoxb-someone-else"),
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "Set up a new Slack App instead",
      );
      expect(startSlackAppMock).not.toHaveBeenCalled();

      await app.close();
    });
  });

  describe("DELETE /api/chatops/bots/:id", () => {
    test("is refused while an agent uses the app, and names the agent", async ({
      makeOrganization,
      makeUser,
      makeAgent,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({
        organizationId: organization.id,
        authorId: user.id,
        name: "Clode",
        agentType: "agent",
      });
      const bot = await makeChatOpsBot(organization.id, { name: "Clode" });
      await ChatOpsChannelBindingModel.create({
        organizationId: organization.id,
        provider: "slack",
        botId: bot.id,
        channelId: "C-random",
        workspaceId: "T-test",
        agentId: agent.id,
      });
      const app = await createApp(organization.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/chatops/bots/${bot.id}`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('"Clode"');
      expect(await ChatOpsBotModel.findById(bot.id)).not.toBeNull();
      expect(stopSlackAppMock).not.toHaveBeenCalled();

      await app.close();
    });

    test("is refused while an agent has a card for the app even with no channel, and names the agent", async ({
      makeOrganization,
      makeUser,
      makeAgent,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      const user = await makeUser();
      const agent = await makeAgent({
        organizationId: organization.id,
        authorId: user.id,
        name: "Card Holder",
        agentType: "agent",
      });
      const bot = await makeChatOpsBot(organization.id, { name: "Clode" });
      await ChatOpsChannelBindingModel.applyAssignmentPlan({
        organizationId: organization.id,
        userId: user.id,
        dmOwnerEmail: user.email,
        targetAgentId: agent.id,
        updates: [],
        directMessages: [],
        bots: [bot.id],
      });
      const app = await createApp(organization.id);

      const refused = await app.inject({
        method: "DELETE",
        url: `/api/chatops/bots/${bot.id}`,
      });

      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.message).toContain('"Card Holder"');
      expect(await ChatOpsBotModel.findById(bot.id)).not.toBeNull();
      expect(stopSlackAppMock).not.toHaveBeenCalled();

      // Dropping the card frees the app for removal.
      await ChatOpsChannelBindingModel.applyAssignmentPlan({
        organizationId: organization.id,
        userId: user.id,
        dmOwnerEmail: user.email,
        targetAgentId: agent.id,
        updates: [],
        directMessages: [],
        bots: [],
      });
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/chatops/bots/${bot.id}`,
      });

      expect(removed.statusCode).toBe(200);
      expect(await ChatOpsBotModel.findById(bot.id)).toBeNull();

      await app.close();
    });

    test("stops the app, drops its channels and keeps env vars from re-seeding it", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      const archestra = await makeChatOpsBot(organization.id, {
        name: "Archestra",
      });
      const clode = await makeChatOpsBot(organization.id, { name: "Clode" });
      for (const bot of [archestra, clode]) {
        await ChatOpsChannelBindingModel.create({
          organizationId: organization.id,
          provider: "slack",
          botId: bot.id,
          channelId: "C-engineering",
          workspaceId: "T-test",
          agentId: null,
        });
      }
      const app = await createApp(organization.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/chatops/bots/${clode.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(stopSlackAppMock).toHaveBeenCalledWith(clode.id);
      expect(await ChatOpsBotModel.findById(clode.id)).toBeNull();
      // Clode's channel went with it; Archestra's identical channel stays.
      expect(
        await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          botId: clode.id,
          channelId: "C-engineering",
          workspaceId: "T-test",
        }),
      ).toBeNull();
      expect(
        await ChatOpsChannelBindingModel.findByChannel({
          provider: "slack",
          botId: archestra.id,
          channelId: "C-engineering",
          workspaceId: "T-test",
        }),
      ).not.toBeNull();
      expect(await ChatOpsConfigModel.isSlackEnvSeedingDisabled()).toBe(true);

      await app.close();
    });

    test("reports an unknown app as missing", async ({ makeOrganization }) => {
      const organization = await makeOrganization();
      const app = await createApp(organization.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/chatops/bots/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    });
  });
});
