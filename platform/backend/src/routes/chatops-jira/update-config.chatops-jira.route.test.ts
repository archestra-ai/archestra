import AuditLogModel from "@/models/audit-log";
import ChatOpsConfigModel from "@/models/chatops-config";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  JIRA_TEST_SECRET,
  JIRA_TEST_SITE,
  seedJiraConfig,
  useJiraRouteTest,
} from "./chatops-jira.test-helpers";

describe("Jira ChatOps update-config", () => {
  const { ctx } = useJiraRouteTest();
  const payload = {
    enabled: true,
    siteUrl: `${JIRA_TEST_SITE}/jira/`,
    ingressMode: "hmac",
    webhookSecret: JIRA_TEST_SECRET,
  };

  test("saves the canonical Cloud site, preserves an omitted secret, and audits a redacted change", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload,
    });
    expect(response.statusCode).toBe(200);
    const first = await ChatOpsConfigModel.getJiraConfig();
    expect(first).toMatchObject({
      siteUrl: JIRA_TEST_SITE,
      organizationId: ctx.organizationId,
      webhookSecret: JIRA_TEST_SECRET,
    });
    const second = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload: {
        enabled: false,
        siteUrl: JIRA_TEST_SITE,
        ingressMode: "automation",
      },
    });
    expect(second.statusCode).toBe(200);
    expect((await ChatOpsConfigModel.getJiraConfig())?.webhookSecret).toBe(
      JIRA_TEST_SECRET,
    );
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "chatOpsConfig",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(2);
    for (const audit of data) {
      expect(audit.action).toBe("chatOpsConfig.updated");
      expect(audit.before).not.toEqual(audit.after);
      expect(JSON.stringify(audit)).not.toContain(JIRA_TEST_SECRET);
    }
  });

  test("polling needs no webhook secret and persists an enable boundary", async () => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload: { enabled: true, siteUrl: JIRA_TEST_SITE, ingressMode: "poll" },
    });
    expect(response.statusCode).toBe(200);
    const current = await ChatOpsConfigModel.getJiraConfig();
    expect(current?.pollStartedAt).toBeTruthy();
    expect(current?.pollSince).toBeTruthy();
    expect(response.json().pollingSupported).toBe(true);
    expect(response.json().hasWebhookSecret).toBe(false);
    const switchMode = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload: { enabled: true, siteUrl: JIRA_TEST_SITE, ingressMode: "hmac" },
    });
    expect(switchMode.statusCode).toBe(400);
  });

  test.each([
    "http://example.atlassian.net",
    "https://example.test",
    "https://example.atlassian.net:443",
    "https://user:pass@example.atlassian.net",
    "https://example.atlassian.net/?token=x",
    "https://example.atlassian.net/rest/api/3",
  ])("rejects unsafe or ambiguous site %s", async (siteUrl) => {
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload: { ...payload, siteUrl },
    });
    expect(response.statusCode).toBe(400);
    expect(await ChatOpsConfigModel.getJiraConfig()).toBeNull();
  });

  test("refuses changing site while a bot is connected", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId, agent.id);
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload: { ...payload, siteUrl: "https://another.atlassian.net" },
    });
    expect(response.statusCode).toBe(409);
    expect((await ChatOpsConfigModel.getJiraConfig())?.siteUrl).toBe(
      JIRA_TEST_SITE,
    );
  });

  test("refuses settings writes by an ordinary member", async ({
    makeUser,
    makeMember,
  }) => {
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId);
    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/chatops/jira/config",
      payload,
    });
    expect(response.statusCode).toBe(403);
    expect(await ChatOpsConfigModel.getJiraConfig()).toBeNull();
  });
});
