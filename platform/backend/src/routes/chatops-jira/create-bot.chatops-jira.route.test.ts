import { HttpResponse, http } from "msw";
import AuditLogModel from "@/models/audit-log";
import ChatOpsConfigModel from "@/models/chatops-config";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  JIRA_TEST_SITE,
  seedJiraConfig,
  useJiraRouteTest,
} from "./chatops-jira.test-helpers";

describe("Jira ChatOps create-bot", () => {
  const { ctx, server } = useJiraRouteTest();
  const credentials = {
    email: "bot@example.test",
    apiToken: "test-only-api-token",
  };

  test("verifies a Jira identity before pinning it to an agent and never returns the token", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: agent.id,
      accountId: "jira-bot-account",
      displayName: "Issue helper",
      hasApiToken: true,
    });
    expect(response.body).not.toContain(credentials.apiToken);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        accountId: "jira-bot-account",
        apiToken: credentials.apiToken,
      }),
    ]);
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "chatOpsConfig",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      action: "chatOpsConfig.updated",
      outcome: "success",
    });
    expect(data[0].before).not.toEqual(data[0].after);
    expect(JSON.stringify(data)).not.toContain(credentials.apiToken);
  });

  test("reports Jira HTTP status on failed verification without returning credentials", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId);
    server.use(
      http.get(
        `${JIRA_TEST_SITE}/rest/api/3/myself`,
        () => new HttpResponse(null, { status: 401 }),
      ),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Jira returned HTTP 401");
    expect(response.body).not.toContain(credentials.apiToken);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toHaveLength(0);
  });

  test("accepts an active organization service account reported by Jira as an app", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId);
    server.use(
      http.get(`${JIRA_TEST_SITE}/rest/api/3/myself`, () =>
        HttpResponse.json({
          accountId: "service-account-principal",
          accountType: "app",
          displayName: "Test service bot",
          active: true,
          emailAddress: credentials.email,
        }),
      ),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: "service-account-principal",
      displayName: "Test service bot",
      hasApiToken: true,
    });
    expect(response.body).not.toContain(credentials.apiToken);
  });

  test("rejects duplicate external identities and duplicate agent pins", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const other = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId, agent.id);
    const repeatedIdentity = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: other.id, ...credentials },
    });
    expect(repeatedIdentity.statusCode).toBe(409);
    server.use(
      http.get(`${JIRA_TEST_SITE}/rest/api/3/myself`, () =>
        HttpResponse.json({
          accountId: "another-jira-account",
          displayName: "Other helper",
          active: true,
        }),
      ),
    );
    const repeatedAgent = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(repeatedAgent.statusCode).toBe(409);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toHaveLength(1);
  });

  test("connects a scoped token through the fixed Atlassian gateway and exposes only its cloud ID", async ({
    makeInternalAgent,
  }) => {
    const cloudId = "e32a7d40-b40b-4ca6-a901-74e08e3243e9";
    const gateway = `https://api.atlassian.com/ex/jira/${cloudId}`;
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    await seedJiraConfig(ctx.organizationId);
    let discoveryHadAuthorization = true;
    let gatewayIdentityCalls = 0;
    let gatewayProjectCalls = 0;
    server.use(
      http.get(`${JIRA_TEST_SITE}/_edge/tenant_info`, ({ request }) => {
        discoveryHadAuthorization = request.headers.has("authorization");
        return HttpResponse.json({ cloudId });
      }),
      http.get(`${JIRA_TEST_SITE}/rest/api/3/myself`, () =>
        HttpResponse.json({}, { status: 401 }),
      ),
      http.get(`${gateway}/rest/api/3/myself`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`,
        );
        gatewayIdentityCalls++;
        return HttpResponse.json({
          accountId: "jira-scoped-bot-account",
          displayName: "Scoped issue helper",
          active: true,
        });
      }),
      http.get(`${gateway}/rest/api/3/project/search`, () => {
        gatewayProjectCalls++;
        return HttpResponse.json({
          values: [{ id: "10000", key: "TEST", name: "Disposable project" }],
          isLast: true,
        });
      }),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, tokenType: "scoped", ...credentials },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: agent.id,
      accountId: "jira-scoped-bot-account",
      cloudId,
      hasApiToken: true,
    });
    expect(response.body).not.toContain(credentials.apiToken);
    expect(discoveryHadAuthorization).toBe(false);
    expect(gatewayIdentityCalls).toBe(1);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots[0].cloudId).toBe(
      cloudId,
    );
    const projects = await ctx.app.inject({
      method: "GET",
      url: `/api/chatops/jira/bots/${response.json().id}/projects`,
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual([
      { id: "10000", key: "TEST", name: "Disposable project" },
    ]);
    expect(gatewayProjectCalls).toBe(1);
  });

  test("refuses another organization's agent before contacting Jira", async ({
    makeInternalAgent,
    makeOrganization,
  }) => {
    await seedJiraConfig(ctx.organizationId);
    const agent = await makeInternalAgent({
      organizationId: (await makeOrganization()).id,
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(response.statusCode).toBe(404);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toEqual([]);
  });

  test("settings permission alone cannot connect an agent the caller cannot share", async ({
    makeInternalAgent,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
      authorId: ctx.user.id,
      access: "personal",
    });
    await seedJiraConfig(ctx.organizationId);
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { organizationSettings: ["read", "update"], agent: ["read"] },
    });
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/jira/bots",
      payload: { agentId: agent.id, ...credentials },
    });
    expect(response.statusCode).toBe(403);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots).toEqual([]);
  });
});
