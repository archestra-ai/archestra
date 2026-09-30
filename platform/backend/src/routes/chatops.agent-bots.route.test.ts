import { vi } from "vitest";
import { hasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { AgentChatOpsBotModel, ChatOpsChannelBindingModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { Agent, User } from "@/types";
import chatopsRoutes from "./chatops";

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: vi.fn(),
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getTelegramProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(),
  },
}));
vi.mock("@/auth");

/**
 * An agent speaks through one bot per provider (its cards). These cover how
 * the binding routes enforce that, and how the status response reports the
 * agents of each bot.
 */
describe("ChatOps agent bots", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let botA: { id: string; name: string };
  let botB: { id: string; name: string };
  let agent: Agent;

  beforeEach(
    async ({
      makeAdmin,
      makeAgent,
      makeChatOpsBot,
      makeMember,
      makeOrganization,
    }) => {
      organizationId = (await makeOrganization()).id;
      botA = await makeChatOpsBot(organizationId, { name: "Bot A" });
      botB = await makeChatOpsBot(organizationId, { name: "Bot B" });
      user = await makeAdmin({ email: "operator@example.com" });
      await makeMember(user.id, organizationId, { role: "admin" });
      agent = await makeAgent({
        organizationId,
        authorId: user.id,
        agentType: "agent",
        name: "Support",
      });
      vi.mocked(hasPermission).mockResolvedValue({
        success: true,
        error: null,
      });

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user, organizationId });
      });
      await app.register(chatopsRoutes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("one bot per provider on binding assignment", () => {
    test("PATCH refuses a channel of a second Slack bot, naming the bot the agent already uses", async () => {
      await makeBinding({ botId: botA.id, agentId: agent.id });
      const other = await makeBinding({ botId: botB.id, agentId: null });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/chatops/bindings/${other.id}`,
        payload: { agentId: agent.id },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('"Bot A"');
      expect(
        (await ChatOpsChannelBindingModel.findById(other.id))?.agentId,
      ).toBeNull();
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botA.id,
      ]);
    });

    test("PATCH still allows more channels of the same bot, unassigning, and a bot of another provider", async ({
      makeChatOpsBot,
    }) => {
      await makeBinding({ botId: botA.id, agentId: agent.id });
      const sameBot = await makeBinding({ botId: botA.id, agentId: null });
      const otherBotChannel = await makeBinding({
        botId: botB.id,
        agentId: null,
      });
      const teams = await makeChatOpsBot(organizationId, {
        provider: "ms-teams",
      });
      const teamsChannel = await makeBinding({
        botId: teams.id,
        agentId: null,
        provider: "ms-teams",
      });

      const same = await patch(sameBot.id, { agentId: agent.id });
      const otherProvider = await patch(teamsChannel.id, {
        agentId: agent.id,
      });
      const unassign = await patch(otherBotChannel.id, { agentId: null });

      expect(same.statusCode, same.body).toBe(200);
      expect(otherProvider.statusCode, otherProvider.body).toBe(200);
      expect(unassign.statusCode, unassign.body).toBe(200);
      expect(
        (await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).sort(),
      ).toEqual([botA.id, teams.id].sort());
    });

    test("bulk PATCH refuses the whole batch when any channel belongs to a second Slack bot", async () => {
      await makeBinding({ botId: botA.id, agentId: agent.id });
      const fine = await makeBinding({ botId: botA.id, agentId: null });
      const conflicting = await makeBinding({ botId: botB.id, agentId: null });

      const response = await app.inject({
        method: "PATCH",
        url: "/api/chatops/bindings",
        payload: { ids: [fine.id, conflicting.id], agentId: agent.id },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain('"Bot A"');
      expect(
        (await ChatOpsChannelBindingModel.findById(fine.id))?.agentId,
      ).toBeNull();
      expect(
        (await ChatOpsChannelBindingModel.findById(conflicting.id))?.agentId,
      ).toBeNull();
    });

    test("bulk PATCH of several channels under one bot gives the agent that bot's card", async () => {
      const first = await makeBinding({ botId: botB.id, agentId: null });
      const second = await makeBinding({ botId: botB.id, agentId: null });

      const response = await app.inject({
        method: "PATCH",
        url: "/api/chatops/bindings",
        payload: { ids: [first.id, second.id], agentId: agent.id },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(await AgentChatOpsBotModel.findBotIdsByAgent(agent.id)).toEqual([
        botB.id,
      ]);
    });
  });

  describe("GET /api/chatops/status", () => {
    test("lists each bot's agents from cards and channels, without duplicates", async ({
      makeAgent,
    }) => {
      const cardOnly = await makeAgent({
        organizationId,
        authorId: user.id,
        agentType: "agent",
        name: "Alpha",
      });
      await ChatOpsChannelBindingModel.applyAssignmentPlan({
        organizationId,
        userId: user.id,
        dmOwnerEmail: user.email,
        targetAgentId: cardOnly.id,
        updates: [],
        directMessages: [],
        bots: [botA.id],
      });
      // "Support" holds a channel and therefore a card; it appears once.
      await makeBinding({ botId: botA.id, agentId: agent.id });
      await makeBinding({ botId: botA.id, agentId: agent.id });

      const response = await app.inject({
        method: "GET",
        url: "/api/chatops/status",
      });

      expect(response.statusCode).toBe(200);
      const slack = response
        .json()
        .providers.find((provider: { id: string }) => provider.id === "slack");
      const agentsByBot = Object.fromEntries(
        slack.bots.map(
          (bot: {
            id: string;
            agents: Array<{ id: string; name: string }>;
          }) => [bot.id, bot.agents],
        ),
      );
      expect(agentsByBot[botA.id]).toEqual([
        { id: cardOnly.id, name: "Alpha" },
        { id: agent.id, name: "Support" },
      ]);
      expect(agentsByBot[botB.id]).toEqual([]);
    });
  });

  function makeBinding(params: {
    botId: string;
    agentId: string | null;
    provider?: "slack" | "ms-teams";
  }) {
    return ChatOpsChannelBindingModel.create({
      organizationId,
      provider: params.provider ?? "slack",
      botId: params.botId,
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: "T-test",
      channelName: "incident-response",
      agentId: params.agentId,
    });
  }

  function patch(id: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/api/chatops/bindings/${id}`,
      payload,
    });
  }
});
