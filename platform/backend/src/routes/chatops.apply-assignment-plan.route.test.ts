import { CHANNEL_INSTRUCTIONS_MAX_LENGTH } from "@archestra/shared";
import { vi } from "vitest";
import { hasPermission } from "@/auth";
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
vi.mock("@/auth");

describe("POST /api/chatops/bindings/assignment-plan", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let activeOrganizationId: string;
  let organizationId: string;
  let originalOwner: Agent;
  let targetAgent: Agent;

  beforeEach(async ({ makeAdmin, makeAgent, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    activeOrganizationId = organizationId;
    user = await makeAdmin({ email: "operator@example.com" });
    originalOwner = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    targetAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId: activeOrganizationId });
    });
    await app.register(chatopsRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("atomically assigns a channel, saves its settings, and creates a pending DM", async () => {
    const binding = await makeBinding(null);

    const response = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: null,
          nextAgentId: targetAgent.id,
          channelInstructions: "  Escalate urgent requests.  ",
          answerAllMessages: true,
        },
      ],
      // Unknown body fields must not override the authenticated DM owner.
      directMessages: [
        { provider: "slack", dmOwnerEmail: "attacker@example.com" },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(await ChatOpsChannelBindingModel.findById(binding.id)).toMatchObject(
      {
        agentId: targetAgent.id,
        channelInstructions: "Escalate urgent requests.",
        answerAllMessages: true,
      },
    );
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({
      agentId: targetAgent.id,
      channelId: ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId,
        dmOwnerEmail: user.email,
      }),
    });
  });

  test("rolls back every binding when one expected owner is stale", async ({
    makeAgent,
  }) => {
    const first = await makeBinding(originalOwner.id);
    const second = await makeBinding(originalOwner.id);
    const newerOwner = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    await ChatOpsChannelBindingModel.update(second.id, {
      agentId: newerOwner.id,
    });

    const response = await apply({
      updates: [
        {
          bindingId: first.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
        },
        {
          bindingId: second.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
        },
      ],
    });

    expect(response.statusCode).toBe(409);
    expect((await ChatOpsChannelBindingModel.findById(first.id))?.agentId).toBe(
      originalOwner.id,
    );
    expect(
      (await ChatOpsChannelBindingModel.findById(second.id))?.agentId,
    ).toBe(newerOwner.id);
  });

  test("rejects invalid settings and target assignments without changing bindings", async ({
    makeAgent,
  }) => {
    const binding = await makeBinding(originalOwner.id);
    const otherTarget = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });

    const invalidSettings = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
          channelInstructions: "x".repeat(CHANNEL_INSTRUCTIONS_MAX_LENGTH + 1),
        },
      ],
    });
    const invalidTarget = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: otherTarget.id,
        },
      ],
    });
    const dmBinding = await makeBinding(originalOwner.id, true);
    const invalidReplyBehavior = await apply({
      updates: [
        {
          bindingId: dmBinding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
          answerAllMessages: true,
        },
      ],
    });

    expect(invalidSettings.statusCode).toBe(400);
    expect(invalidTarget.statusCode).toBe(400);
    expect(invalidReplyBehavior.statusCode).toBe(400);
    expect(await ChatOpsChannelBindingModel.findById(binding.id)).toMatchObject(
      {
        agentId: originalOwner.id,
        channelInstructions: null,
      },
    );
  });

  test("atomically mixes assignments, unassignments, and channel details", async () => {
    const unassigned = await makeBinding(null);
    const assigned = await makeBinding(originalOwner.id);
    const detailed = await makeBinding(targetAgent.id);

    const response = await apply({
      updates: [
        {
          bindingId: unassigned.id,
          expectedAgentId: null,
          nextAgentId: targetAgent.id,
        },
        {
          bindingId: assigned.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: null,
          channelInstructions: "Do not answer deployment questions.",
        },
        {
          bindingId: detailed.id,
          expectedAgentId: targetAgent.id,
          nextAgentId: targetAgent.id,
          answerAllMessages: true,
        },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(
      await ChatOpsChannelBindingModel.findById(unassigned.id),
    ).toMatchObject({
      agentId: targetAgent.id,
    });
    expect(
      await ChatOpsChannelBindingModel.findById(assigned.id),
    ).toMatchObject({
      agentId: null,
      channelInstructions: "Do not answer deployment questions.",
    });
    expect(
      await ChatOpsChannelBindingModel.findById(detailed.id),
    ).toMatchObject({
      agentId: targetAgent.id,
      answerAllMessages: true,
    });
  });

  test("enforces target agent type and personal-agent restrictions", async ({
    makeAgent,
    makeUser,
  }) => {
    const channelBinding = await makeBinding(originalOwner.id);
    const dmBinding = await makeBinding(originalOwner.id, true);
    const gatewayAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "mcp_gateway",
      scope: "org",
    });
    const ownPersonalAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "personal",
    });
    const otherUser = await makeUser();
    const otherPersonalAgent = await makeAgent({
      organizationId,
      authorId: otherUser.id,
      agentType: "agent",
      scope: "personal",
    });
    const anotherUsersDm = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "another-users-dm",
      workspaceId: "another-users-workspace",
      isDm: true,
      dmOwnerEmail: otherUser.email,
      agentId: originalOwner.id,
    });

    const nonInternal = await apply({
      targetAgentId: gatewayAgent.id,
      updates: [
        {
          bindingId: channelBinding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: gatewayAgent.id,
        },
      ],
    });
    const personalChannel = await apply({
      targetAgentId: ownPersonalAgent.id,
      updates: [
        {
          bindingId: channelBinding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: ownPersonalAgent.id,
        },
      ],
    });
    const otherPersonalDm = await apply({
      targetAgentId: otherPersonalAgent.id,
      updates: [
        {
          bindingId: dmBinding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: otherPersonalAgent.id,
        },
      ],
    });
    const wrongOwnerDm = await apply({
      targetAgentId: ownPersonalAgent.id,
      updates: [
        {
          bindingId: anotherUsersDm.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: ownPersonalAgent.id,
        },
      ],
    });

    expect(nonInternal.statusCode).toBe(400);
    expect(personalChannel.statusCode).toBe(400);
    expect(otherPersonalDm.statusCode).toBe(403);
    expect(wrongOwnerDm.statusCode).toBe(403);
    expect(
      (await ChatOpsChannelBindingModel.findById(channelBinding.id))?.agentId,
    ).toBe(originalOwner.id);
    expect(
      (await ChatOpsChannelBindingModel.findById(dmBinding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  test("rolls back binding updates when a pending DM conflicts", async () => {
    const binding = await makeBinding(originalOwner.id);
    await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: ChatOpsChannelBindingModel.pendingDmChannelId({
        organizationId,
        dmOwnerEmail: user.email,
      }),
      workspaceId: "dm:pending",
      channelName: `Direct Message - ${user.email}`,
      isDm: true,
      dmOwnerEmail: user.email,
      agentId: originalOwner.id,
    });

    const response = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
        },
      ],
      directMessages: [{ provider: "slack" }],
    });

    expect(response.statusCode).toBe(409);
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  test("requires trigger-create permission only when creating a pending DM", async () => {
    const binding = await makeBinding(originalOwner.id);
    vi.mocked(hasPermission).mockResolvedValue({
      success: false,
      error: new Error("Forbidden"),
    });

    const updateOnly = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: targetAgent.id,
        },
      ],
    });
    const withDm = await apply({
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: targetAgent.id,
          nextAgentId: targetAgent.id,
        },
      ],
      directMessages: [{ provider: "slack" }],
    });

    expect(updateOnly.statusCode).toBe(200);
    expect(withDm.statusCode).toBe(403);
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(targetAgent.id);
  });

  test("rejects foreign target agents and bindings without revealing or changing them", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const localBinding = await makeBinding(originalOwner.id);
    const otherOrganization = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: otherOrganization.id,
      agentType: "agent",
      scope: "org",
    });
    const foreignBinding = await ChatOpsChannelBindingModel.create({
      organizationId: otherOrganization.id,
      provider: "slack",
      channelId: "foreign-channel",
      workspaceId: "foreign-workspace",
      agentId: foreignAgent.id,
    });

    const foreignTarget = await apply({
      targetAgentId: foreignAgent.id,
      updates: [
        {
          bindingId: localBinding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: foreignAgent.id,
        },
      ],
    });
    const foreignBindingResponse = await apply({
      updates: [
        {
          bindingId: foreignBinding.id,
          expectedAgentId: foreignAgent.id,
          nextAgentId: targetAgent.id,
        },
      ],
    });

    expect(foreignTarget.statusCode).toBe(404);
    expect(foreignBindingResponse.statusCode).toBe(404);
    expect(
      (await ChatOpsChannelBindingModel.findById(localBinding.id))?.agentId,
    ).toBe(originalOwner.id);
    expect(
      (await ChatOpsChannelBindingModel.findById(foreignBinding.id))?.agentId,
    ).toBe(foreignAgent.id);
  });

  test("creates pending DMs for the same email independently in each organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization();
    const otherTarget = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });

    const first = await apply({
      directMessages: [{ provider: "slack" }],
    });
    activeOrganizationId = otherOrganization.id;
    const second = await apply({
      targetAgentId: otherTarget.id,
      directMessages: [{ provider: "slack" }],
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId,
        provider: "slack",
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({ agentId: targetAgent.id });
    expect(
      await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
        organizationId: otherOrganization.id,
        provider: "slack",
        dmOwnerEmail: user.email,
      }),
    ).toMatchObject({ agentId: otherTarget.id });
  });

  test("does not assign a team agent the caller cannot access", async ({
    makeAgent,
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    const member = await makeUser({ email: "member@example.com" });
    const teamOwner = await makeUser({ email: "team-owner@example.com" });
    await makeMember(member.id, organizationId);
    await makeMember(teamOwner.id, organizationId);
    const privateTeam = await makeTeam(organizationId, teamOwner.id);
    const inaccessibleAgent = await makeAgent({
      organizationId,
      authorId: teamOwner.id,
      agentType: "agent",
      scope: "team",
      teams: [privateTeam.id],
    });
    const binding = await makeBinding(originalOwner.id);
    user = member;
    vi.mocked(hasPermission).mockImplementation(async (permissions) =>
      permissions.agent?.includes("admin")
        ? { success: false, error: new Error("Forbidden") }
        : { success: true, error: null },
    );

    const response = await apply({
      targetAgentId: inaccessibleAgent.id,
      updates: [
        {
          bindingId: binding.id,
          expectedAgentId: originalOwner.id,
          nextAgentId: inaccessibleAgent.id,
        },
      ],
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Agent not found" },
    });
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  function makeBinding(agentId: string | null, isDm = false) {
    return ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: `T${crypto.randomUUID().slice(0, 10)}`,
      channelName: "incident-response",
      isDm,
      dmOwnerEmail: isDm ? user.email : null,
      agentId,
    });
  }

  function apply(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/chatops/bindings/assignment-plan",
      payload: {
        targetAgentId: targetAgent.id,
        updates: [],
        directMessages: [],
        ...payload,
      },
    });
  }
});
