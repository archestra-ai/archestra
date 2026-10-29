import AuditLogModel from "@/models/audit-log";
import ChatOpsConfigModel from "@/models/chatops-config";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import { seedJiraConfig, useJiraRouteTest } from "./chatops-jira.test-helpers";

describe("Jira ChatOps update-bot", () => {
  const { ctx } = useJiraRouteTest();

  test("disables a bot without discarding its credentials and audits the change", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/chatops/jira/bots/${saved.bots[0].id}`,
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      hasApiToken: true,
    });
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots[0]).toMatchObject({
      enabled: false,
      apiToken: saved.bots[0].apiToken,
    });
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "chatOpsConfig",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].before).not.toEqual(data[0].after);
    expect(JSON.stringify(data)).not.toContain(saved.bots[0].apiToken);
  });

  test("requires an explicit fallback pair and refuses unverified reviewers or foreign service accounts", async ({
    makeInternalAgent,
    makeServiceAccount,
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const service = await makeServiceAccount(ctx.organizationId);
    const unverified = await makeUser({ emailVerified: false });
    await makeMember(unverified.id, ctx.organizationId);
    const url = `/api/chatops/jira/bots/${saved.bots[0].id}`;
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url,
          payload: { fallbackServiceAccountId: service.id },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url,
          payload: {
            fallbackServiceAccountId: service.id,
            fallbackReviewerUserId: unverified.id,
          },
        })
      ).statusCode,
    ).toBe(400);
    const foreign = await makeServiceAccount((await makeOrganization()).id);
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url,
          payload: {
            fallbackServiceAccountId: foreign.id,
            fallbackReviewerUserId: ctx.user.id,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await ChatOpsConfigModel.getJiraConfig())?.bots[0]
        .fallbackServiceAccountId,
    ).toBeUndefined();
  });

  test("saves and clears a fallback only when the service and verified reviewer can use the agent", async ({
    makeInternalAgent,
    makeServiceAccount,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const service = await makeServiceAccount(ctx.organizationId, {
      role: "admin",
    });
    const url = `/api/chatops/jira/bots/${saved.bots[0].id}`;
    const response = await ctx.app.inject({
      method: "PATCH",
      url,
      payload: {
        fallbackServiceAccountId: service.id,
        fallbackReviewerUserId: ctx.user.id,
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await ChatOpsConfigModel.getJiraConfig())?.bots[0]).toMatchObject({
      fallbackServiceAccountId: service.id,
      fallbackReviewerUserId: ctx.user.id,
    });
    const cleared = await ctx.app.inject({
      method: "PATCH",
      url,
      payload: { fallbackServiceAccountId: null, fallbackReviewerUserId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      fallbackServiceAccountId: null,
      fallbackReviewerUserId: null,
    });
  });
});
