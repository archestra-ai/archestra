import { vi } from "vitest";
import { ChatOpsChannelBindingModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
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
  let targetAgent: Agent;

  beforeEach(async ({ makeAdmin, makeAgent, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin({ email: "operator@example.com" });
    targetAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(chatopsRoutes);
  });

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
        dmOwnerEmail: user.email,
      });
    expect(binding?.agentId).toBe(targetAgent.id);
    expect(binding?.workspaceId).toBe("dm:pending");
  });

  test("rejects a guarded DM when another session created it", async ({
    makeAgent,
  }) => {
    const existingOwner = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    const existing = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
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
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const otherAgent = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    const otherBinding = await ChatOpsChannelBindingModel.create({
      organizationId: otherOrganization.id,
      provider: "slack",
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
