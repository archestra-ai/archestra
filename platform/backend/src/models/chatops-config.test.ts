import { describe, expect, test } from "@/test";
import ChatOpsConfigModel from "./chatops-config";

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
    test("returns null when no config exists", async () => {
      const result = await ChatOpsConfigModel.getSlackConfig();
      expect(result).toBeNull();
    });

    test("saves and retrieves Slack config", async () => {
      const slackConfig = {
        enabled: true,
        botToken: "xoxb-test-token",
        signingSecret: "test-signing-secret",
        appId: "A12345",
      };

      await ChatOpsConfigModel.saveSlackConfig(slackConfig);
      const result = await ChatOpsConfigModel.getSlackConfig();

      expect(result).toEqual({
        ...slackConfig,
        connectionMode: "webhook",
        appLevelToken: "",
      });
    });

    test("updates existing Slack config", async () => {
      const initial = {
        enabled: true,
        botToken: "xoxb-token-1",
        signingSecret: "secret-1",
        appId: "A111",
      };

      await ChatOpsConfigModel.saveSlackConfig(initial);

      const updated = {
        ...initial,
        botToken: "xoxb-token-2",
        enabled: false,
      };

      await ChatOpsConfigModel.saveSlackConfig(updated);
      const result = await ChatOpsConfigModel.getSlackConfig();

      expect(result).toEqual({
        ...updated,
        connectionMode: "webhook",
        appLevelToken: "",
      });
      expect(result?.botToken).toBe("xoxb-token-2");
      expect(result?.enabled).toBe(false);
    });
  });

  describe("independent storage", () => {
    test("MS Teams and Slack configs are stored independently", async () => {
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
      await ChatOpsConfigModel.saveSlackConfig(slackConfig);

      const teams = await ChatOpsConfigModel.getMsTeamsConfig();
      const slack = await ChatOpsConfigModel.getSlackConfig();

      expect(teams).toEqual(msTeamsConfig);
      expect(slack).toEqual({
        ...slackConfig,
        connectionMode: "webhook",
        appLevelToken: "",
      });
    });
  });
});
