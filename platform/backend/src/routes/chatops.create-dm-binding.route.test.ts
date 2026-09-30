import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ChatOpsChannelBindingModel } from "@/models";
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

describe("POST /api/chatops/bindings/dm", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let botId: string;
  let targetAgent: Agent;

  beforeEach(
    async ({
      makeAdmin,
      makeAgent,
      makeChatOpsBot,
      makeOrganization,
      makeMember,
    }) => {
      organizationId = (await makeOrganization()).id;
      botId = (await makeChatOpsBot(organizationId)).id;
      user = await makeAdmin({ email: "operator@example.com" });
      await makeMember(user.id, organizationId, { role: "admin" });
      targetAgent = await makeAgent({
        organizationId,
        authorId: user.id,
        agentType: "agent",
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

  test("creates a guarded pending DM when none exists", async () => {
    const response = await post({
      provider: "slack",
      agentId: targetAgent.id,
      requireNoExistingBinding: true,
    });

    expect(response.statusCode).toBe(200);
    const binding =
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId,
        dmOwnerEmail: user.email,
      });
    expect(binding?.agentId).toBe(targetAgent.id);
    expect(binding?.workspaceId).toBe("dm:pending");
    expect(binding?.botId).toBe(botId);
  });

  test("creates the DM binding under the named bot and gives a second bot of the provider its own", async ({
    makeAgent,
    makeChatOpsBot,
  }) => {
    const secondBot = await makeChatOpsBot(organizationId);
    const secondAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
    });

    const first = await post({
      provider: "slack",
      botId,
      agentId: targetAgent.id,
    });
    const second = await post({
      provider: "slack",
      botId: secondBot.id,
      agentId: secondAgent.id,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ botId });
    expect(second.json()).toMatchObject({ botId: secondBot.id });
    expect(first.json().id).not.toBe(second.json().id);
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId,
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({ agentId: targetAgent.id });
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId: secondBot.id,
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({ agentId: secondAgent.id });
  });

  test("defaults to the provider's first bot when no botId is given", async ({
    makeChatOpsBot,
  }) => {
    const laterBot = await makeChatOpsBot(organizationId);

    const response = await post({ provider: "slack", agentId: targetAgent.id });

    expect(response.statusCode).toBe(200);
    expect(response.json().botId).toBe(botId);
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId: laterBot.id,
        dmOwnerEmail: user.email,
      }),
    ).toBeNull();
  });

  test("reports an unknown bot, or one of another provider or organization, as 404 and creates nothing", async ({
    makeChatOpsBot,
    makeOrganization,
  }) => {
    const teamsBot = await makeChatOpsBot(organizationId, {
      provider: "ms-teams",
    });
    const foreignBot = await makeChatOpsBot((await makeOrganization()).id);

    for (const unknownBotId of [
      crypto.randomUUID(),
      teamsBot.id,
      foreignBot.id,
    ]) {
      const response = await post({
        provider: "slack",
        botId: unknownBotId,
        agentId: targetAgent.id,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toBe("Bot not found");
    }
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId,
        dmOwnerEmail: user.email,
      }),
    ).toBeNull();
  });

  test("rejects a guarded DM when another session created it", async ({
    makeAgent,
  }) => {
    const existingOwner = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
    });
    const existing = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      botId,
      channelId: ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId,
        dmOwnerEmail: user.email,
      }),
      workspaceId: "dm:pending",
      isDm: true,
      dmOwnerEmail: user.email,
      agentId: existingOwner.id,
    });

    const response = await post({
      provider: "slack",
      agentId: targetAgent.id,
      requireNoExistingBinding: true,
    });

    expect(response.statusCode).toBe(409);
    expect(
      (await ChatOpsChannelBindingModel.findById(existing.id))?.agentId,
    ).toBe(existingOwner.id);
  });

  test("creates an independent pending DM for the same email in another organization", async ({
    makeAgent,
    makeChatOpsBot,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const otherBot = await makeChatOpsBot(otherOrganization.id);
    const otherAgent = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: user.id,
      agentType: "agent",
    });
    const otherBinding = await ChatOpsChannelBindingModel.create({
      organizationId: otherOrganization.id,
      provider: "slack",
      botId: otherBot.id,
      channelId: ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId: otherOrganization.id,
        dmOwnerEmail: user.email,
      }),
      workspaceId: "dm:pending",
      isDm: true,
      dmOwnerEmail: user.email,
      agentId: otherAgent.id,
    });

    const response = await post({
      provider: "slack",
      agentId: targetAgent.id,
    });

    expect(response.statusCode).toBe(200);
    expect(
      (await ChatOpsChannelBindingModel.findById(otherBinding.id))?.agentId,
    ).toBe(otherAgent.id);
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        botId,
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({ agentId: targetAgent.id });
  });

  function post(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/chatops/bindings/dm",
      payload,
    });
  }
});
