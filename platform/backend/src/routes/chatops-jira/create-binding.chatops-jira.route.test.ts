import { HttpResponse, http } from "msw";
import AuditLogModel from "@/models/audit-log";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import { describe, expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";
import {
  JIRA_TEST_SITE,
  seedJiraConfig,
  useJiraRouteTest,
} from "./chatops-jira.test-helpers";

describe("Jira ChatOps create-binding", () => {
  const { ctx, server } = useJiraRouteTest();

  test("verifies project access and binds canonical metadata to the pinned agent with instructions", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    server.use(
      http.get(`${JIRA_TEST_SITE}/rest/api/3/project/10001`, () =>
        HttpResponse.json({
          id: "10001",
          key: "DEMO",
          name: "Demo project",
        }),
      ),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/chatops/jira/bots/${saved.bots[0].id}/bindings`,
      payload: { projectId: "10001", instructions: "  Summarize only.  " },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "jira",
      workspaceId: saved.id,
      channelId: `${saved.bots[0].id}:10001`,
      channelName: "DEMO · Demo project",
      agentId: agent.id,
      channelInstructions: "Summarize only.",
    });
    expect(
      await ChatOpsChannelBindingModel.findById(response.json().id),
    ).toMatchObject({
      organizationId: ctx.organizationId,
      agentId: agent.id,
      channelInstructions: "Summarize only.",
    });
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "chatOpsBinding",
      limit: 10,
      offset: 0,
    });
    expect(data).toHaveLength(1);
    expect(data[0].before).not.toEqual(data[0].after);
    expect(JSON.stringify(data)).not.toContain(saved.bots[0].apiToken);
  });

  test("a denied project probe creates no binding", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    server.use(
      http.get(
        `${JIRA_TEST_SITE}/rest/api/3/project/10001`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: `/api/chatops/jira/bots/${saved.bots[0].id}/bindings`,
      payload: { projectId: "10001" },
    });
    expect(response.statusCode).toBe(400);
    expect(
      await ChatOpsChannelBindingModel.findByOrganization(ctx.organizationId),
    ).toEqual([]);
  });
});
