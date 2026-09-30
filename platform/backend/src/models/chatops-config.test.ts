import { describe, expect, test } from "@/test";
import ChatOpsBotModel from "./chatops-bot";
import ChatOpsConfigModel from "./chatops-config";
import SecretModel from "./secret";

describe("ChatOpsConfigModel", () => {
  describe("MS Teams config", () => {
    test("returns null when no config exists", async () => {
      const result = await ChatOpsConfigModel.getMsTeamsConfig();
      expect(result).toBeNull();
    });

    test("saves and retrieves MS Teams config", async () => {
      const msTeamsConfig = {
        enabled: true,
        appId: "test-app-id",
        appSecret: "test-app-secret",
        tenantId: "test-tenant-id",
        graphTenantId: "test-graph-tenant-id",
        graphClientId: "test-graph-client-id",
        graphClientSecret: "test-graph-client-secret",
      };

      await ChatOpsConfigModel.saveMsTeamsConfig(msTeamsConfig);
      const result = await ChatOpsConfigModel.getMsTeamsConfig();

      expect(result).toEqual(msTeamsConfig);
    });

    test("updates existing MS Teams config", async () => {
      const initial = {
        enabled: true,
        appId: "app-1",
        appSecret: "secret-1",
        tenantId: "tenant-1",
        graphTenantId: "graph-tenant-1",
        graphClientId: "graph-client-1",
        graphClientSecret: "graph-secret-1",
      };

      await ChatOpsConfigModel.saveMsTeamsConfig(initial);

      const updated = {
        ...initial,
        appId: "app-2",
        appSecret: "secret-2",
      };

      await ChatOpsConfigModel.saveMsTeamsConfig(updated);
      const result = await ChatOpsConfigModel.getMsTeamsConfig();

      expect(result).toEqual(updated);
      expect(result?.appId).toBe("app-2");
    });
  });

  describe("Slack config", () => {
    test("returns null when the bot has no secret yet", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);

      expect(bot.secretId).toBeNull();
      expect(await ChatOpsConfigModel.getSlackConfig(bot)).toBeNull();
    });

    test("first save creates the secret and links it to the bot", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const slackConfig = {
        enabled: true,
        botToken: "xoxb-test-token",
        signingSecret: "test-signing-secret",
        appId: "A12345",
      };

      const saved = await ChatOpsConfigModel.saveSlackConfig({
        bot,
        value: slackConfig,
      });

      expect(saved.id).toBe(bot.id);
      expect(saved.secretId).toEqual(expect.any(String));
      // The link is persisted on the bot row, not just on the returned object.
      const reloaded = await ChatOpsBotModel.findById(bot.id);
      expect(reloaded?.secretId).toBe(saved.secretId);
      expect(
        await SecretModel.findById(saved.secretId as string),
      ).not.toBeNull();

      const result = await ChatOpsConfigModel.getSlackConfig(saved);
      expect(result).toEqual({
        ...slackConfig,
        connectionMode: "webhook",
        appLevelToken: "",
      });
    });

    test("later saves reuse the same secret and overwrite its value", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const initial = {
        enabled: true,
        botToken: "xoxb-token-1",
        signingSecret: "secret-1",
        appId: "A111",
      };

      const first = await ChatOpsConfigModel.saveSlackConfig({
        bot,
        value: initial,
      });
      const updated = {
        ...initial,
        botToken: "xoxb-token-2",
        enabled: false,
      };
      const second = await ChatOpsConfigModel.saveSlackConfig({
        bot: first,
        value: updated,
      });

      expect(second.secretId).toBe(first.secretId);
      const result = await ChatOpsConfigModel.getSlackConfig(second);
      expect(result).toEqual({
        ...updated,
        connectionMode: "webhook",
        appLevelToken: "",
      });
      expect(result?.botToken).toBe("xoxb-token-2");
      expect(result?.enabled).toBe(false);
    });

    test("two bots keep separate credentials", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id);
      const botB = await makeChatOpsBot(org.id);

      const savedA = await ChatOpsConfigModel.saveSlackConfig({
        bot: botA,
        value: {
          enabled: true,
          botToken: "xoxb-a",
          signingSecret: "sign-a",
          appId: "AAAA",
        },
      });
      const savedB = await ChatOpsConfigModel.saveSlackConfig({
        bot: botB,
        value: {
          enabled: true,
          botToken: "xoxb-b",
          signingSecret: "sign-b",
          appId: "BBBB",
        },
      });

      expect(savedA.secretId).not.toBe(savedB.secretId);
      expect((await ChatOpsConfigModel.getSlackConfig(savedA))?.botToken).toBe(
        "xoxb-a",
      );
      expect((await ChatOpsConfigModel.getSlackConfig(savedB))?.botToken).toBe(
        "xoxb-b",
      );

      // Updating one bot never touches the other's credentials.
      await ChatOpsConfigModel.saveSlackConfig({
        bot: savedA,
        value: {
          enabled: true,
          botToken: "xoxb-a-rotated",
          signingSecret: "sign-a",
          appId: "AAAA",
        },
      });
      expect((await ChatOpsConfigModel.getSlackConfig(savedB))?.botToken).toBe(
        "xoxb-b",
      );
    });

    test("deleteSlackConfig removes only that bot's secret", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const savedA = await ChatOpsConfigModel.saveSlackConfig({
        bot: await makeChatOpsBot(org.id),
        value: {
          enabled: true,
          botToken: "xoxb-a",
          signingSecret: "sign-a",
          appId: "AAAA",
        },
      });
      const savedB = await ChatOpsConfigModel.saveSlackConfig({
        bot: await makeChatOpsBot(org.id),
        value: {
          enabled: true,
          botToken: "xoxb-b",
          signingSecret: "sign-b",
          appId: "BBBB",
        },
      });

      await ChatOpsConfigModel.deleteSlackConfig(savedA);

      expect(await SecretModel.findById(savedA.secretId as string)).toBeNull();
      expect((await ChatOpsConfigModel.getSlackConfig(savedB))?.botToken).toBe(
        "xoxb-b",
      );
    });
  });

  describe("ngrok config", () => {
    test("returns null when no config exists", async () => {
      const result = await ChatOpsConfigModel.getNgrokConfig();
      expect(result).toBeNull();
    });

    test("saves, retrieves, and updates ngrok config", async () => {
      await ChatOpsConfigModel.saveNgrokConfig({
        authToken: "tok_1",
        domain: "",
      });
      expect(await ChatOpsConfigModel.getNgrokConfig()).toEqual({
        authToken: "tok_1",
        domain: "",
      });

      await ChatOpsConfigModel.saveNgrokConfig({
        authToken: "tok_2",
        domain: "my-app.ngrok.app",
      });
      expect(await ChatOpsConfigModel.getNgrokConfig()).toEqual({
        authToken: "tok_2",
        domain: "my-app.ngrok.app",
      });
    });
  });

  describe("independent storage", () => {
    test("MS Teams and Slack configs are stored independently", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id);
      const msTeamsConfig = {
        enabled: true,
        appId: "teams-app",
        appSecret: "teams-secret",
        tenantId: "teams-tenant",
        graphTenantId: "teams-graph-tenant",
        graphClientId: "teams-graph-client",
        graphClientSecret: "teams-graph-secret",
      };

      const slackConfig = {
        enabled: true,
        botToken: "xoxb-slack",
        signingSecret: "slack-signing",
        appId: "SLACK123",
      };

      await ChatOpsConfigModel.saveMsTeamsConfig(msTeamsConfig);
      const savedBot = await ChatOpsConfigModel.saveSlackConfig({
        bot,
        value: slackConfig,
      });

      const teams = await ChatOpsConfigModel.getMsTeamsConfig();
      const slack = await ChatOpsConfigModel.getSlackConfig(savedBot);

      expect(teams).toEqual(msTeamsConfig);
      expect(slack).toEqual({
        ...slackConfig,
        connectionMode: "webhook",
        appLevelToken: "",
      });
    });
  });
});
