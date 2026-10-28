import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import ChatOpsConfigModel from "@/models/chatops-config";
import { beforeEach, describe, expect, test } from "@/test";
import chatopsRoutes from "../chatops";
import { seedJiraConfig, useJiraRouteTest } from "./chatops-jira.test-helpers";

describe("Jira ChatOps pinned-bindings", () => {
  const { ctx } = useJiraRouteTest();
  beforeEach(async () => {
    await ctx.app.register(chatopsRoutes);
  });

  test("generic single, bulk, and assignment-plan routes cannot transfer or unpin a Jira bot", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const other = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const binding = await ChatOpsChannelBindingModel.create({
      organizationId: ctx.organizationId,
      provider: "jira",
      workspaceId: saved.id,
      channelId: `${saved.bots[0].id}:10001`,
      agentId: agent.id,
    });
    for (const nextAgentId of [null, other.id]) {
      const single = await ctx.app.inject({
        method: "PATCH",
        url: `/api/chatops/bindings/${binding.id}`,
        payload: { agentId: nextAgentId },
      });
      expect(single.statusCode).toBe(409);
      const bulk = await ctx.app.inject({
        method: "PATCH",
        url: "/api/chatops/bindings",
        payload: { ids: [binding.id], agentId: nextAgentId },
      });
      expect(bulk.statusCode).toBe(409);
      const plan = await ctx.app.inject({
        method: "POST",
        url: "/api/chatops/bindings/assignment-plan",
        payload: {
          targetAgentId: other.id,
          directMessages: [],
          updates: [
            { bindingId: binding.id, expectedAgentId: agent.id, nextAgentId },
          ],
        },
      });
      expect(plan.statusCode).toBe(409);
      expect(
        (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
      ).toBe(agent.id);
    }
    const instructions = await ctx.app.inject({
      method: "PATCH",
      url: `/api/chatops/bindings/${binding.id}`,
      payload: { channelInstructions: "Use the project conventions." },
    });
    expect(instructions.statusCode).toBe(200);
    expect(instructions.json()).toMatchObject({
      agentId: agent.id,
      channelInstructions: "Use the project conventions.",
    });
  });

  test("Jira cannot be configured as a direct-message channel", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/bindings/dm",
      payload: { provider: "jira", agentId: agent.id },
    });
    expect(response.statusCode).toBe(400);
    const plan = await ctx.app.inject({
      method: "POST",
      url: "/api/chatops/bindings/assignment-plan",
      payload: {
        targetAgentId: agent.id,
        updates: [],
        directMessages: [{ provider: "jira" }],
      },
    });
    expect(plan.statusCode).toBe(400);
    expect(
      await ChatOpsChannelBindingModel.findByOrganization(ctx.organizationId),
    ).toEqual([]);
  });

  test("generic provider status reports Jira without credentials", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/chatops/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toContainEqual({
      id: "jira",
      displayName: "Jira",
      configured: true,
    });
    expect(response.body).not.toContain(saved.webhookSecret);
    expect(response.body).not.toContain(saved.bots[0].apiToken);
  });

  test("polling reports configured without a webhook secret", async ({
    makeInternalAgent,
  }) => {
    const agent = await makeInternalAgent({
      organizationId: ctx.organizationId,
    });
    const saved = await seedJiraConfig(ctx.organizationId, agent.id);
    await ChatOpsConfigModel.saveJiraConfig({
      ...saved,
      ingressMode: "poll",
      webhookSecret: "",
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/chatops/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().providers).toContainEqual({
      id: "jira",
      displayName: "Jira",
      configured: true,
    });
    expect(response.body).not.toContain(saved.bots[0].apiToken);
  });
});
