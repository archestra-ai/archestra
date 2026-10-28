import { describe, expect, test } from "@/test";
import {
  JIRA_TEST_SECRET,
  seedJiraConfig,
  useJiraRouteTest,
} from "./chatops-jira.test-helpers";

describe("Jira ChatOps get", () => {
  const { ctx } = useJiraRouteTest();

  test("reads the saved site and bot without returning credentials or ownership metadata", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/chatops/jira/config",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: saved.id,
      siteUrl: saved.siteUrl,
      hasWebhookSecret: true,
      pollingSupported: true,
      bots: [
        { accountId: "jira-bot-account", agentId: agent.id, hasApiToken: true },
      ],
    });
    expect(response.json().organizationId).toBeUndefined();
    expect(response.body).not.toContain(JIRA_TEST_SECRET);
    expect(response.body).not.toContain(saved.bots[0].apiToken);
  });

  test("does not disclose another organization's Jira configuration", async ({
    makeOrganization,
  }) => {
    await seedJiraConfig((await makeOrganization()).id);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/chatops/jira/config",
    });
    expect(response.statusCode).toBe(404);
  });
});
