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

describe("PATCH /api/chatops/bindings", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let originalOwner: Agent;
  let targetAgent: Agent;

  beforeEach(async ({ makeAdmin, makeAgent, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
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

  test("updates a binding when its expected owner still matches", async () => {
    const binding = await makeBinding(originalOwner.id);

    const response = await patch({
      ids: [binding.id],
      agentId: targetAgent.id,
      expectedAgentAssignments: [{ id: binding.id, agentId: originalOwner.id }],
    });

    expect(response.statusCode).toBe(200);
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(targetAgent.id);
  });

  test("rejects a stale owner and preserves the newer assignment", async ({
    makeAgent,
  }) => {
    const binding = await makeBinding(originalOwner.id);
    const newerOwner = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "org",
    });
    await ChatOpsChannelBindingModel.update(binding.id, {
      agentId: newerOwner.id,
    });

    const response = await patch({
      ids: [binding.id],
      agentId: targetAgent.id,
      expectedAgentAssignments: [{ id: binding.id, agentId: originalOwner.id }],
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe(
      "Channel assignments changed. Reload the channels and try again.",
    );
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(newerOwner.id);
  });

  test("reports missing and foreign bindings as tenant-neutral not-found errors", async ({
    makeAgent,
    makeOrganization,
  }) => {
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
    const missingBindingId = crypto.randomUUID();

    const missing = await patch({
      ids: [missingBindingId],
      agentId: targetAgent.id,
      expectedAgentAssignments: [
        { id: missingBindingId, agentId: originalOwner.id },
      ],
    });
    const foreign = await patch({
      ids: [foreignBinding.id],
      agentId: targetAgent.id,
      expectedAgentAssignments: [
        { id: foreignBinding.id, agentId: foreignAgent.id },
      ],
    });

    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe("Binding not found");
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.message).toBe("Binding not found");
    expect(
      (await ChatOpsChannelBindingModel.findById(foreignBinding.id))?.agentId,
    ).toBe(foreignAgent.id);
  });

  test("requires an expected owner for each binding in a guarded update", async () => {
    const first = await makeBinding(originalOwner.id);
    const second = await makeBinding(originalOwner.id);

    const response = await patch({
      ids: [first.id, second.id],
      agentId: targetAgent.id,
      expectedAgentAssignments: [{ id: first.id, agentId: originalOwner.id }],
    });

    expect(response.statusCode).toBe(400);
    expect((await ChatOpsChannelBindingModel.findById(first.id))?.agentId).toBe(
      originalOwner.id,
    );
    expect(
      (await ChatOpsChannelBindingModel.findById(second.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  test("rejects an agent from another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const binding = await makeBinding(originalOwner.id);
    const otherOrganization = await makeOrganization();
    const foreignAgent = await makeAgent({
      organizationId: otherOrganization.id,
      agentType: "agent",
      scope: "org",
    });

    const response = await patch({
      ids: [binding.id],
      agentId: foreignAgent.id,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Agent not found");
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  test("rejects a non-internal agent", async ({ makeAgent }) => {
    const binding = await makeBinding(originalOwner.id);
    const gatewayAgent = await makeAgent({
      organizationId,
      agentType: "mcp_gateway",
      scope: "org",
    });

    const response = await patch({
      ids: [binding.id],
      agentId: gatewayAgent.id,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "Only internal agents can be assigned to ChatOps.",
    );
    expect(
      (await ChatOpsChannelBindingModel.findById(binding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  test("rejects assigning a personal agent to another user's DM on legacy routes", async ({
    makeAgent,
  }) => {
    const personalAgent = await makeAgent({
      organizationId,
      authorId: user.id,
      agentType: "agent",
      scope: "personal",
    });
    const dmBinding = await ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: "another-users-dm",
      workspaceId: "another-users-workspace",
      isDm: true,
      dmOwnerEmail: "another-user@example.com",
      agentId: originalOwner.id,
    });

    const single = await app.inject({
      method: "PATCH",
      url: `/api/chatops/bindings/${dmBinding.id}`,
      payload: { agentId: personalAgent.id },
    });
    const bulk = await patch({
      ids: [dmBinding.id],
      agentId: personalAgent.id,
      expectedAgentAssignments: [
        { id: dmBinding.id, agentId: originalOwner.id },
      ],
    });

    expect(single.statusCode).toBe(403);
    expect(bulk.statusCode).toBe(403);
    expect(
      (await ChatOpsChannelBindingModel.findById(dmBinding.id))?.agentId,
    ).toBe(originalOwner.id);
  });

  function makeBinding(agentId: string | null) {
    return ChatOpsChannelBindingModel.create({
      organizationId,
      provider: "slack",
      channelId: `C${crypto.randomUUID().slice(0, 10)}`,
      workspaceId: `T${crypto.randomUUID().slice(0, 10)}`,
      channelName: "incident-response",
      agentId,
    });
  }

  function patch(payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: "/api/chatops/bindings",
      payload,
    });
  }
});
