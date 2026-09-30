import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import ChatOpsChannelBindingModel from "./chatops-channel-binding";

describe("ChatOpsChannelBindingModel", () => {
  test("uses the newest pending direct-message assignment", async ({
    makeAgent,
    makeOrganization,
    makeChatOpsBot,
  }) => {
    const organization = await makeOrganization();
    const bot = await makeChatOpsBot(organization.id, { provider: "slack" });
    const firstAgent = await makeAgent({ organizationId: organization.id });
    const secondAgent = await makeAgent({ organizationId: organization.id });
    const first = await ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      botId: bot.id,
      provider: "slack",
      channelId: "dm:pending:user@example.com",
      workspaceId: null,
      agentId: firstAgent.id,
      isDm: true,
      dmOwnerEmail: "user@example.com",
    });
    const newest = await ChatOpsChannelBindingModel.create({
      organizationId: organization.id,
      botId: bot.id,
      provider: "slack",
      channelId: "dm:pending:user@example.com",
      workspaceId: "dm:pending",
      agentId: secondAgent.id,
      isDm: true,
      dmOwnerEmail: "user@example.com",
    });
    // Updates use the application clock; inserts use the database clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(
      Math.max(first.updatedAt.getTime(), newest.updatedAt.getTime()) + 1_000,
    );
    await ChatOpsChannelBindingModel.updateByIdAndOrganization({
      id: newest.id,
      organizationId: organization.id,
      input: { agentId: secondAgent.id },
    });

    const pending = await ChatOpsChannelBindingModel.findPendingDmBinding({
      organizationId: organization.id,
      botId: bot.id,
      provider: "slack",
      dmOwnerEmail: "user@example.com",
    });

    expect(pending?.id).toBe(newest.id);
    expect(pending?.agentId).toBe(secondAgent.id);
  });

  test("resolves and fulfills pending direct messages only inside their organization", async ({
    makeOrganization,
    makeChatOpsBot,
  }) => {
    const [firstOrganization, secondOrganization] = await Promise.all([
      makeOrganization(),
      makeOrganization(),
    ]);
    const [firstBot, secondBot] = await Promise.all([
      makeChatOpsBot(firstOrganization.id, { provider: "slack" }),
      makeChatOpsBot(secondOrganization.id, { provider: "slack" }),
    ]);
    const first = await ChatOpsChannelBindingModel.create({
      organizationId: firstOrganization.id,
      botId: firstBot.id,
      provider: "slack",
      channelId: `dm:pending:${firstOrganization.id}:user@example.com`,
      workspaceId: "dm:pending",
      isDm: true,
      dmOwnerEmail: "user@example.com",
    });
    const second = await ChatOpsChannelBindingModel.create({
      organizationId: secondOrganization.id,
      botId: secondBot.id,
      provider: "slack",
      channelId: `dm:pending:${secondOrganization.id}:user@example.com`,
      workspaceId: "dm:pending",
      isDm: true,
      dmOwnerEmail: "user@example.com",
    });

    const resolved = await ChatOpsChannelBindingModel.findPendingDmBinding({
      organizationId: firstOrganization.id,
      botId: firstBot.id,
      provider: "slack",
      dmOwnerEmail: "user@example.com",
    });
    const foreignFulfillment =
      await ChatOpsChannelBindingModel.fulfillDmBinding({
        id: second.id,
        organizationId: firstOrganization.id,
        realChannelId: "D-foreign",
        workspaceId: "T-foreign",
      });

    expect(resolved?.id).toBe(first.id);
    expect(foreignFulfillment).toBeNull();
    expect(await ChatOpsChannelBindingModel.findById(second.id)).toMatchObject({
      channelId: second.channelId,
      workspaceId: "dm:pending",
    });
  });

  describe("create", () => {
    test("creates a channel binding with required fields", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const binding = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent.id,
      });

      expect(binding).toBeDefined();
      expect(binding.id).toBeDefined();
      expect(binding.organizationId).toBe(org.id);
      expect(binding.provider).toBe("ms-teams");
      expect(binding.channelId).toBe("channel-123");
      expect(binding.workspaceId).toBe("workspace-456");
      expect(binding.agentId).toBe(agent.id);
    });

    test("creates only one pending DM for the same provider and user", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const agent = await makeAgent({ agentType: "agent" });
      const input = {
        organizationId: org.id,
        botId: bot.id,
        provider: "slack" as const,
        channelId: "dm:pending:user@example.com",
        workspaceId: "dm:pending",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      };

      const [first, second] = await Promise.all([
        ChatOpsChannelBindingModel.createPendingDmIfAbsent(input),
        ChatOpsChannelBindingModel.createPendingDmIfAbsent(input),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
    });
  });

  describe("findByChannel", () => {
    test("finds binding by provider, channelId, and workspaceId", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
      });

      expect(binding).toBeDefined();
      expect(binding?.channelId).toBe("channel-123");
    });

    test("returns null when binding not found", async () => {
      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: "00000000-0000-0000-0000-000000000000",
        provider: "ms-teams",
        channelId: "nonexistent",
        workspaceId: "nonexistent",
      });

      expect(binding).toBeNull();
    });

    test("finds binding with null workspaceId", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-ms-teams",
        workspaceId: null,
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-ms-teams",
        workspaceId: null,
      });

      expect(binding).toBeDefined();
      expect(binding?.channelId).toBe("channel-ms-teams");
    });
  });

  describe("findById", () => {
    test("finds binding by ID", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findById(created.id);

      expect(binding).toBeDefined();
      expect(binding?.id).toBe(created.id);
    });

    test("returns null for nonexistent ID", async () => {
      const binding = await ChatOpsChannelBindingModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(binding).toBeNull();
    });
  });

  describe("findByIdAndOrganization", () => {
    test("finds binding by ID and organization", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByIdAndOrganization(
        created.id,
        org.id,
      );

      expect(binding).toBeDefined();
      expect(binding?.id).toBe(created.id);
    });

    test("returns null for wrong organization", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org1 = await makeOrganization();
      const bot1 = await makeChatOpsBot(org1.id, { provider: "ms-teams" });
      const org2 = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org1.id,
        botId: bot1.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByIdAndOrganization(
        created.id,
        org2.id,
      );

      expect(binding).toBeNull();
    });
  });

  describe("findByOrganization", () => {
    test("returns all bindings for an organization", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-1",
        agentId: agent1.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-2",
        agentId: agent2.id,
      });

      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );

      expect(bindings).toHaveLength(2);
    });

    test("returns empty array when no bindings exist", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(bindings).toHaveLength(0);
    });
  });

  describe("findByAgentId", () => {
    test("returns all bindings for an agent", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-2",
        agentId: agent.id,
      });

      const bindings = await ChatOpsChannelBindingModel.findByAgentId(agent.id);

      expect(bindings).toHaveLength(2);
    });
  });

  describe("update", () => {
    test("updates binding fields", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent1.id,
      });

      const updated = await ChatOpsChannelBindingModel.update(created.id, {
        agentId: agent2.id,
      });

      expect(updated).toBeDefined();
      expect(updated?.agentId).toBe(agent2.id);
    });

    test("returns null for nonexistent binding", async () => {
      const updated = await ChatOpsChannelBindingModel.update(
        "00000000-0000-0000-0000-000000000000",
        { agentId: "00000000-0000-0000-0000-000000000001" },
      );
      expect(updated).toBeNull();
    });
  });

  describe("findDmBindingByEmailInOrganization", () => {
    test("finds DM binding by provider and email", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "D123",
        workspaceId: "T1",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const found =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          dmOwnerEmail: "user@example.com",
        });

      expect(found).toBeDefined();
      expect(found?.agentId).toBe(agent.id);
      expect(found?.dmOwnerEmail).toBe("user@example.com");
    });

    test("returns null when no DM binding exists", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const organization = await makeOrganization();
      const bot = await makeChatOpsBot(organization.id, { provider: "slack" });
      const found =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: organization.id,
          botId: bot.id,
          provider: "slack",
          dmOwnerEmail: "nobody@example.com",
        });

      expect(found).toBeNull();
    });

    test("returns most recently updated binding when multiple exist", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      const first = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "D-old",
        workspaceId: "T1",
        agentId: agent1.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const second = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "D-new",
        workspaceId: "T1",
        agentId: agent2.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      // Consecutive inserts can share a timestamp. Control the clock used by
      // updates so this tests recency independently of database clock resolution.
      vi.useFakeTimers({ toFake: ["Date"] });
      const updateTime =
        Math.max(first.updatedAt.getTime(), second.updatedAt.getTime()) + 1_000;
      vi.setSystemTime(updateTime);
      await ChatOpsChannelBindingModel.update(second.id, {
        agentId: agent2.id,
      });

      const found =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          dmOwnerEmail: "user@example.com",
        });

      expect(found).toBeDefined();
      expect(found?.agentId).toBe(agent2.id);
      expect(found?.channelId).toBe("D-new");

      // Updating the first-created binding must make it the preferred binding.
      vi.setSystemTime(updateTime + 1_000);
      await ChatOpsChannelBindingModel.update(first.id, { agentId: agent1.id });

      const afterUpdate =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          dmOwnerEmail: "user@example.com",
        });

      expect(afterUpdate?.id).toBe(first.id);
      expect(afterUpdate?.agentId).toBe(agent1.id);
      expect(afterUpdate?.channelId).toBe("D-old");
    });
  });

  describe("findDmBindingByEmailInOrganization", () => {
    test("does not return a DM binding from another organization", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const [firstOrganization, secondOrganization] = await Promise.all([
        makeOrganization(),
        makeOrganization(),
      ]);
      const [firstBot, secondBot] = await Promise.all([
        makeChatOpsBot(firstOrganization.id, { provider: "slack" }),
        makeChatOpsBot(secondOrganization.id, { provider: "slack" }),
      ]);
      const [firstAgent, secondAgent] = await Promise.all([
        makeAgent({
          organizationId: firstOrganization.id,
          agentType: "agent",
        }),
        makeAgent({
          organizationId: secondOrganization.id,
          agentType: "agent",
        }),
      ]);

      await ChatOpsChannelBindingModel.create({
        organizationId: firstOrganization.id,
        botId: firstBot.id,
        provider: "slack",
        channelId: "D-first",
        workspaceId: "T-first",
        agentId: firstAgent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });
      await ChatOpsChannelBindingModel.create({
        organizationId: secondOrganization.id,
        botId: secondBot.id,
        provider: "slack",
        channelId: "D-second",
        workspaceId: "T-second",
        agentId: secondAgent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const found =
        await ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: secondOrganization.id,
          botId: secondBot.id,
          provider: "slack",
          dmOwnerEmail: "user@example.com",
        });

      expect(found?.id).not.toBeUndefined();
      expect(found?.organizationId).toBe(secondOrganization.id);
      expect(found?.agentId).toBe(secondAgent.id);
    });
  });

  describe("upsertByChannel", () => {
    test("creates new binding when none exists", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "new-channel",
        workspaceId: "workspace-123",
        agentId: agent.id,
      });

      expect(binding).toBeDefined();
      expect(binding.channelId).toBe("new-channel");
    });

    test("updates existing binding when one exists", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      // Create initial binding
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent1.id,
      });

      // Upsert should update the existing binding
      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent2.id,
      });

      expect(binding.agentId).toBe(agent2.id);

      // Verify only one binding exists
      const allBindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(allBindings).toHaveLength(1);
    });

    test("inherits agentId from stale DM binding when creating new one", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const agent = await makeAgent({ agentType: "agent" });

      // Create DM binding with agent and old channelId
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "D-old-channel",
        workspaceId: "T1",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      // Upsert with new channelId but NO agentId — should inherit from stale binding
      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "D-new-channel",
        workspaceId: "T1",
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      expect(binding.agentId).toBe(agent.id);
      expect(binding.channelId).toBe("D-new-channel");

      // Verify old binding was cleaned up
      const old = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "slack",
        channelId: "D-old-channel",
        workspaceId: "T1",
      });
      expect(old).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes binding by ID", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.delete(created.id);

      // Verify binding is deleted
      const binding = await ChatOpsChannelBindingModel.findById(created.id);
      expect(binding).toBeNull();
    });

    test("handles nonexistent binding gracefully", async () => {
      // Should not throw
      await ChatOpsChannelBindingModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
    });
  });

  describe("deleteByIdAndOrganization", () => {
    test("deletes binding when organization matches", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
        created.id,
        org.id,
      );

      // Verify binding is deleted
      const binding = await ChatOpsChannelBindingModel.findById(created.id);
      expect(binding).toBeNull();
    });

    test("does not delete when organization does not match", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org1 = await makeOrganization();
      const bot1 = await makeChatOpsBot(org1.id, { provider: "ms-teams" });
      const org2 = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org1.id,
        botId: bot1.id,
        provider: "ms-teams",
        channelId: "channel-123",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
        created.id,
        org2.id,
      );

      // Verify binding still exists
      const binding = await ChatOpsChannelBindingModel.findById(created.id);
      expect(binding).toBeDefined();
    });

    test("returns the deleted row so callers can drop caches keyed on it", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "channel-cache-key",
        workspaceId: "team-uuid",
      });

      const deleted =
        await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
          created.id,
          org.id,
        );

      // The delete route needs these three to invalidate the answer-all cache;
      // a bare boolean would leave a deleted channel answering until the TTL.
      expect(deleted).toMatchObject({
        provider: "ms-teams",
        channelId: "channel-cache-key",
        workspaceId: "team-uuid",
      });
    });

    test("returns null when there was nothing to delete", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org1 = await makeOrganization();
      const bot1 = await makeChatOpsBot(org1.id, { provider: "ms-teams" });
      const org2 = await makeOrganization();
      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org1.id,
        botId: bot1.id,
        provider: "ms-teams",
        channelId: "channel-other-org",
      });

      expect(
        await ChatOpsChannelBindingModel.deleteByIdAndOrganization(
          created.id,
          org2.id,
        ),
      ).toBeNull();
    });
  });

  describe("ensureChannelsExist", () => {
    test("creates bindings with null agentId for new channels", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General",
            workspaceId: "ws-1",
            workspaceName: "My Team",
          },
          {
            channelId: "ch-2",
            channelName: "Random",
            workspaceId: "ws-1",
            workspaceName: "My Team",
          },
        ],
      });

      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(bindings).toHaveLength(2);
      expect(bindings[0].agentId).toBeNull();
      expect(bindings[1].agentId).toBeNull();
    });

    test("preserves existing agentId when updating names", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      // Create a binding with an agent
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
        channelName: "Old Name",
        agentId: agent.id,
      });

      // Discover the same channel with updated name
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "New Name",
            workspaceId: "ws-1",
            workspaceName: "My Team",
          },
        ],
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
      });
      expect(binding?.agentId).toBe(agent.id);
      expect(binding?.channelName).toBe("New Name");
    });

    test("updates channelName and workspaceName for existing channels", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General",
            workspaceId: "ws-1",
            workspaceName: "Team A",
          },
        ],
      });

      // Update with new names
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General Renamed",
            workspaceId: "ws-1",
            workspaceName: "Team A Renamed",
          },
        ],
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
      });
      expect(binding?.channelName).toBe("General Renamed");
      expect(binding?.workspaceName).toBe("Team A Renamed");

      // Verify only one binding exists (upsert, not duplicate)
      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(bindings).toHaveLength(1);
    });

    test("handles empty channels array (no-op)", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      // Should not throw
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [],
      });

      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(bindings).toHaveLength(0);
    });
  });

  describe("deleteStaleChannels", () => {
    test("deletes bindings for channels not in the active list", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      // Create 3 channels
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
          {
            channelId: "ch-2",
            channelName: "Random",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
          {
            channelId: "ch-3",
            channelName: "Dev",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
        ],
      });

      // Remove ch-2 and ch-3 (they are no longer active)
      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId: org.id,
          botId: bot.id,
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: ["ch-1"],
        },
      );

      expect(deletedCount).toBe(2);

      const bindings = await ChatOpsChannelBindingModel.findByOrganization(
        org.id,
      );
      expect(bindings).toHaveLength(1);
      expect(bindings[0].channelId).toBe("ch-1");
    });

    test("preserves bindings for channels still in the active list", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const agent = await makeAgent({ agentType: "agent" });

      // Create a assigned channel
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId: org.id,
          botId: bot.id,
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: ["ch-1"],
        },
      );

      expect(deletedCount).toBe(0);

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        botId: bot.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
      });
      expect(binding).toBeDefined();
      expect(binding?.agentId).toBe(agent.id);
    });

    test("returns correct count of deleted rows", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
          {
            channelId: "ch-2",
            channelName: "Random",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
        ],
      });

      // All channels are active — nothing deleted
      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId: org.id,
          botId: bot.id,
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: ["ch-1", "ch-2"],
        },
      );

      expect(deletedCount).toBe(0);
    });

    test("handles empty activeChannelIds (returns 0)", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "ms-teams" });

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
        botId: bot.id,
        provider: "ms-teams",
        channels: [
          {
            channelId: "ch-1",
            channelName: "General",
            workspaceId: "ws-1",
            workspaceName: "Team",
          },
        ],
      });

      // Empty activeChannelIds early-returns 0 (safety guard)
      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId: org.id,
          botId: bot.id,
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: [],
        },
      );

      expect(deletedCount).toBe(0);
    });
  });

  describe("findAllPaginated", () => {
    test("returns paginated results with correct pagination metadata", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // Create 5 channels
      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          channelId: `ch-${i}`,
          channelName: `Channel ${i}`,
          workspaceId: "ws-1",
          workspaceName: "Workspace",
          agentId: i < 3 ? agent.id : null,
        });
      }

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 2, offset: 0 },
        filters: { provider: "slack" },
      });

      expect(result.data).toHaveLength(2);
      expect(result.pagination.total).toBe(5);
      expect(result.pagination.totalPages).toBe(3);
      expect(result.pagination.hasNext).toBe(true);
      expect(result.pagination.hasPrev).toBe(false);
    });

    test("applies offset correctly", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          channelId: `ch-${i}`,
          channelName: `Channel ${i}`,
          workspaceId: "ws-1",
          agentId: agent.id,
        });
      }

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 2, offset: 4 },
        filters: { provider: "slack" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.pagination.hasNext).toBe(false);
      expect(result.pagination.hasPrev).toBe(true);
    });

    test("filters by search on channelName", async ({
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-1",
        channelName: "general",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-2",
        channelName: "random",
        workspaceId: "ws-1",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack", search: "gen" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].channelName).toBe("general");
    });

    test("filters by status configured", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-1",
        channelName: "configured-channel",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-2",
        channelName: "unassigned-channel",
        workspaceId: "ws-1",
        agentId: null,
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack", status: "configured" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].agentId).toBe(agent.id);
    });

    test("filters by status unassigned", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-2",
        workspaceId: "ws-1",
        agentId: null,
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack", status: "unassigned" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].agentId).toBeNull();
    });

    test("filters by provider", async ({
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const slackBot = await makeChatOpsBot(org.id, { provider: "slack" });
      const teamsBot = await makeChatOpsBot(org.id, { provider: "ms-teams" });
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: slackBot.id,
        provider: "slack",
        channelId: "ch-slack",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: teamsBot.id,
        provider: "ms-teams",
        channelId: "ch-teams",
        workspaceId: "ws-2",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].provider).toBe("slack");
    });

    test("filters by workspaceId", async ({
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        workspaceName: "Workspace 1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-2",
        workspaceId: "ws-2",
        workspaceName: "Workspace 2",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack", workspaceId: "ws-1" },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].workspaceId).toBe("ws-1");
    });

    test("sorts by channelName ascending", async ({
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-b",
        channelName: "Bravo",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-a",
        channelName: "Alpha",
        workspaceId: "ws-1",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        sorting: { sortBy: "channelName", sortDirection: "asc" },
        filters: { provider: "slack" },
      });

      expect(result.data[0].channelName).toBe("Alpha");
      expect(result.data[1].channelName).toBe("Bravo");
    });

    test("returns correct counts regardless of status filter", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // 2 configured, 3 unassigned
      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
          botId: bot.id,
          provider: "slack",
          channelId: `ch-${i}`,
          channelName: `Channel ${i}`,
          workspaceId: "ws-1",
          agentId: i < 2 ? agent.id : null,
        });
      }

      // Filter to configured only, but counts should reflect all
      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack", status: "configured" },
      });

      expect(result.data).toHaveLength(2);
      expect(result.counts.configured).toBe(2);
      expect(result.counts.unassigned).toBe(3);
    });

    test("hides other users DM bindings", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const currentUser = await makeUser({ email: "current@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // Current user's DM
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "dm-current",
        workspaceId: "ws-1",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "current@example.com",
      });

      // Other user's DM
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "dm-other",
        workspaceId: "ws-1",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "other@example.com",
      });

      // Regular channel
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-regular",
        channelName: "General",
        workspaceId: "ws-1",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: currentUser.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack" },
      });

      // Should see own DM + regular channel, not other user's DM
      expect(result.data).toHaveLength(2);
      const channelIds = result.data.map((b) => b.channelId);
      expect(channelIds).toContain("dm-current");
      expect(channelIds).toContain("ch-regular");
      expect(channelIds).not.toContain("dm-other");
    });

    test("returns workspaces list", async ({
      makeOrganization,
      makeUser,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const bot = await makeChatOpsBot(org.id, { provider: "slack" });
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        workspaceName: "Workspace 1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        botId: bot.id,
        provider: "slack",
        channelId: "ch-2",
        workspaceId: "ws-2",
        workspaceName: "Workspace 2",
      });

      const result = await ChatOpsChannelBindingModel.findAllPaginated({
        organizationId: org.id,
        userEmail: user.email,
        pagination: { limit: 20, offset: 0 },
        filters: { provider: "slack" },
      });

      expect(result.workspaces).toHaveLength(2);
      expect(result.workspaces.map((w) => w.id).sort()).toEqual([
        "ws-1",
        "ws-2",
      ]);
    });
  });

  describe("per-bot isolation", () => {
    const channel = (overrides: { channelName?: string } = {}) => ({
      channelId: "C-shared",
      channelName: overrides.channelName ?? "general",
      workspaceId: "T-shared",
      workspaceName: "Workspace",
    });

    test("two bots in the same channel hold two separate bindings", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      const agentA = await makeAgent({ agentType: "agent" });
      const agentB = await makeAgent({ agentType: "agent" });
      const base = {
        organizationId: org.id,
        provider: "slack" as const,
        channelId: "C-shared",
        workspaceId: "T-shared",
      };

      const bindingA = await ChatOpsChannelBindingModel.create({
        ...base,
        botId: botA.id,
        agentId: agentA.id,
      });
      const bindingB = await ChatOpsChannelBindingModel.create({
        ...base,
        botId: botB.id,
        agentId: agentB.id,
      });

      expect(bindingA.id).not.toBe(bindingB.id);
      const lookup = { provider: "slack" as const, ...channel() };
      expect(
        (
          await ChatOpsChannelBindingModel.findByChannel({
            ...lookup,
            botId: botA.id,
          })
        )?.agentId,
      ).toBe(agentA.id);
      expect(
        (
          await ChatOpsChannelBindingModel.findByChannel({
            ...lookup,
            botId: botB.id,
          })
        )?.agentId,
      ).toBe(agentB.id);

      // Re-binding the channel for bot B leaves bot A's binding alone.
      const updatedB = await ChatOpsChannelBindingModel.upsertByChannel({
        ...base,
        botId: botB.id,
        agentId: agentA.id,
      });
      expect(updatedB.id).toBe(bindingB.id);
      expect(
        (await ChatOpsChannelBindingModel.findById(bindingA.id))?.agentId,
      ).toBe(agentA.id);
      expect(
        await ChatOpsChannelBindingModel.findByOrganization(org.id),
      ).toHaveLength(2);
    });

    test("ensureChannelsExist for one bot never renames or creates another bot's bindings", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      const discover = (botId: string, channelName: string) =>
        ChatOpsChannelBindingModel.ensureChannelsExist({
          organizationId: org.id,
          provider: "slack",
          botId,
          channels: [channel({ channelName })],
        });

      await discover(botA.id, "name-a");
      await discover(botB.id, "name-b");
      await discover(botA.id, "name-a-renamed");

      const lookup = { provider: "slack" as const, ...channel() };
      expect(
        (
          await ChatOpsChannelBindingModel.findByChannel({
            ...lookup,
            botId: botA.id,
          })
        )?.channelName,
      ).toBe("name-a-renamed");
      expect(
        (
          await ChatOpsChannelBindingModel.findByChannel({
            ...lookup,
            botId: botB.id,
          })
        )?.channelName,
      ).toBe("name-b");
      expect(
        await ChatOpsChannelBindingModel.findByOrganization(org.id),
      ).toHaveLength(2);
    });

    test("deleteStaleChannels for bot A never deletes bot B's bindings", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      for (const botId of [botA.id, botB.id]) {
        await ChatOpsChannelBindingModel.ensureChannelsExist({
          organizationId: org.id,
          provider: "slack",
          botId,
          channels: [
            { ...channel(), channelId: "C-keep" },
            { ...channel(), channelId: "C-gone" },
          ],
        });
      }

      // Bot A no longer sees C-gone (e.g. it was removed from that channel).
      const deleted = await ChatOpsChannelBindingModel.deleteStaleChannels({
        organizationId: org.id,
        provider: "slack",
        botId: botA.id,
        workspaceIds: ["T-shared"],
        activeChannelIds: ["C-keep"],
      });

      expect(deleted).toBe(1);
      const lookup = {
        provider: "slack" as const,
        workspaceId: "T-shared",
        channelId: "C-gone",
      };
      expect(
        await ChatOpsChannelBindingModel.findByChannel({
          ...lookup,
          botId: botA.id,
        }),
      ).toBeNull();
      expect(
        await ChatOpsChannelBindingModel.findByChannel({
          ...lookup,
          botId: botB.id,
        }),
      ).not.toBeNull();
    });

    test("deduplicateBindings and deleteDuplicateBindings for bot A never touch bot B", async ({
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      const insert = (botId: string, workspaceId: string) =>
        ChatOpsChannelBindingModel.create({
          organizationId: org.id,
          provider: "slack",
          botId,
          channelId: "C-dup",
          workspaceId,
        });
      // The same channel seen under two workspace ids by bot A,
      // plus bot B's own binding of the same channel.
      const [a1, a2, b1, b2] = await Promise.all([
        insert(botA.id, "T-one"),
        insert(botA.id, "T-two"),
        insert(botB.id, "T-one"),
        insert(botB.id, "T-two"),
      ]);

      const removed = await ChatOpsChannelBindingModel.deduplicateBindings({
        provider: "slack",
        botId: botA.id,
        channelIds: ["C-dup"],
      });
      expect(removed).toBe(1);

      const remainingA = [a1, a2].filter(Boolean);
      const survivingA = await ChatOpsChannelBindingModel.findByIds(
        remainingA.map((b) => b.id),
        org.id,
      );
      expect(survivingA).toHaveLength(1);
      // Bot B still has both of its rows.
      expect(
        await ChatOpsChannelBindingModel.findByIds([b1.id, b2.id], org.id),
      ).toHaveLength(2);

      const deletedDuplicates =
        await ChatOpsChannelBindingModel.deleteDuplicateBindings({
          provider: "slack",
          botId: botA.id,
          channelId: "C-dup",
          canonicalBindingId: survivingA[0].id,
        });
      expect(deletedDuplicates).toBe(0);
      expect(
        await ChatOpsChannelBindingModel.findByIds([b1.id, b2.id], org.id),
      ).toHaveLength(2);

      // Targeting bot B removes only bot B's duplicate.
      await ChatOpsChannelBindingModel.deleteDuplicateBindings({
        provider: "slack",
        botId: botB.id,
        channelId: "C-dup",
        canonicalBindingId: b1.id,
      });
      expect(
        await ChatOpsChannelBindingModel.findByIds([b1.id, b2.id], org.id),
      ).toHaveLength(1);
      expect(
        await ChatOpsChannelBindingModel.findByIds([survivingA[0].id], org.id),
      ).toHaveLength(1);
    });

    test("DM bindings for the same email are per bot", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      const agentA = await makeAgent({ agentType: "agent" });
      const agentB = await makeAgent({ agentType: "agent" });
      const dm = (botId: string, channelId: string, agentId?: string) => ({
        organizationId: org.id,
        provider: "slack" as const,
        botId,
        channelId,
        workspaceId: "T1",
        agentId,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const dmA = await ChatOpsChannelBindingModel.create(
        dm(botA.id, "D-a", agentA.id),
      );
      const dmB = await ChatOpsChannelBindingModel.create(
        dm(botB.id, "D-b", agentB.id),
      );
      const find = (botId: string) =>
        ChatOpsChannelBindingModel.findDmBindingByEmailInOrganization({
          organizationId: org.id,
          provider: "slack",
          botId,
          dmOwnerEmail: "user@example.com",
        });

      expect((await find(botA.id))?.id).toBe(dmA.id);
      expect((await find(botB.id))?.id).toBe(dmB.id);

      // Re-initiating the DM with bot A swaps A's stale row (inheriting its
      // agent) and leaves the same user's DM with bot B alone.
      const reopened = await ChatOpsChannelBindingModel.upsertByChannel(
        dm(botA.id, "D-a-new"),
      );
      expect(reopened.agentId).toBe(agentA.id);
      expect(await ChatOpsChannelBindingModel.findById(dmA.id)).toBeNull();
      expect(await ChatOpsChannelBindingModel.findById(dmB.id)).toMatchObject({
        channelId: "D-b",
        agentId: agentB.id,
      });
    });

    test("pending DM assignments are per bot", async ({
      makeAgent,
      makeOrganization,
      makeChatOpsBot,
    }) => {
      const org = await makeOrganization();
      const botA = await makeChatOpsBot(org.id, { provider: "slack" });
      const botB = await makeChatOpsBot(org.id, { provider: "slack" });
      const agent = await makeAgent({ agentType: "agent" });
      const pending = await ChatOpsChannelBindingModel.createPendingDmIfAbsent({
        organizationId: org.id,
        provider: "slack",
        botId: botA.id,
        channelId: "dm:pending:user@example.com",
        workspaceId: "dm:pending",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });
      const lookup = (botId: string) =>
        ChatOpsChannelBindingModel.findPendingDmBinding({
          organizationId: org.id,
          provider: "slack",
          botId,
          dmOwnerEmail: "user@example.com",
        });

      expect((await lookup(botA.id))?.id).toBe(pending?.id);
      expect(await lookup(botB.id)).toBeNull();
    });
  });
});
