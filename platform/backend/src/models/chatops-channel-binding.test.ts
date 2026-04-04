import { describe, expect, test } from "@/test";
import ChatOpsChannelBindingModel from "./chatops-channel-binding";

describe("ChatOpsChannelBindingModel", () => {
  describe("create", () => {
    test("creates a channel binding with required fields", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const binding = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
  });

  describe("findByChannel", () => {
    test("finds binding by provider, channelId, and workspaceId", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
      });

      expect(binding).toBeDefined();
      expect(binding?.channelId).toBe("channel-123");
    });

    test("returns null when binding not found", async () => {
      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "ms-teams",
        channelId: "nonexistent",
        workspaceId: "nonexistent",
      });

      expect(binding).toBeNull();
    });

    test("finds binding with null workspaceId", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-ms-teams",
        workspaceId: null,
        agentId: agent.id,
      });

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "ms-teams",
        channelId: "channel-ms-teams",
        workspaceId: null,
      });

      expect(binding).toBeDefined();
      expect(binding?.channelId).toBe("channel-ms-teams");
    });
  });

  describe("findById", () => {
    test("finds binding by ID", async ({ makeAgent, makeOrganization }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org1.id,
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
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-1",
        agentId: agent1.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-2",
        agentId: agent.id,
      });

      const bindings = await ChatOpsChannelBindingModel.findByAgentId(agent.id);

      expect(bindings).toHaveLength(2);
    });
  });

  describe("update", () => {
    test("updates binding fields", async ({ makeAgent, makeOrganization }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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

  describe("findDmBindingByEmail", () => {
    test("finds DM binding by provider and email", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "D123",
        workspaceId: "T1",
        agentId: agent.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const found = await ChatOpsChannelBindingModel.findDmBindingByEmail(
        "slack",
        "user@example.com",
      );

      expect(found).toBeDefined();
      expect(found?.agentId).toBe(agent.id);
      expect(found?.dmOwnerEmail).toBe("user@example.com");
    });

    test("returns null when no DM binding exists", async () => {
      const found = await ChatOpsChannelBindingModel.findDmBindingByEmail(
        "slack",
        "nobody@example.com",
      );

      expect(found).toBeNull();
    });

    test("returns most recently updated binding when multiple exist", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      // Create older binding
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "D-old",
        workspaceId: "T1",
        agentId: agent1.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      // Create newer binding
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "D-new",
        workspaceId: "T1",
        agentId: agent2.id,
        isDm: true,
        dmOwnerEmail: "user@example.com",
      });

      const found = await ChatOpsChannelBindingModel.findDmBindingByEmail(
        "slack",
        "user@example.com",
      );

      expect(found).toBeDefined();
      expect(found?.agentId).toBe(agent2.id);
      expect(found?.channelId).toBe("D-new");
    });
  });

  describe("upsertByChannel", () => {
    test("creates new binding when none exists", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ agentType: "agent" });
      const agent2 = await makeAgent({ agentType: "agent" });

      // Create initial binding
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "channel-123",
        workspaceId: "workspace-456",
        agentId: agent1.id,
      });

      // Upsert should update the existing binding
      const binding = await ChatOpsChannelBindingModel.upsertByChannel({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      // Create DM binding with agent and old channelId
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
        provider: "slack",
        channelId: "D-old-channel",
        workspaceId: "T1",
      });
      expect(old).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes binding by ID", async ({ makeAgent, makeOrganization }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      const created = await ChatOpsChannelBindingModel.create({
        organizationId: org1.id,
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
  });

  describe("ensureChannelsExist", () => {
    test("creates bindings with null agentId for new channels", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      // Create a binding with an agent
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
        channelName: "Old Name",
        agentId: agent.id,
      });

      // Discover the same channel with updated name
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
      });
      expect(binding?.agentId).toBe(agent.id);
      expect(binding?.channelName).toBe("New Name");
    });

    test("updates channelName and workspaceName for existing channels", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();

      // Should not throw
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();

      // Create 3 channels
      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ agentType: "agent" });

      // Create a assigned channel
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      const deletedCount = await ChatOpsChannelBindingModel.deleteStaleChannels(
        {
          organizationId: org.id,
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: ["ch-1"],
        },
      );

      expect(deletedCount).toBe(0);

      const binding = await ChatOpsChannelBindingModel.findByChannel({
        provider: "ms-teams",
        channelId: "ch-1",
        workspaceId: "ws-1",
      });
      expect(binding).toBeDefined();
      expect(binding?.agentId).toBe(agent.id);
    });

    test("returns correct count of deleted rows", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
          provider: "ms-teams",
          workspaceIds: ["ws-1"],
          activeChannelIds: ["ch-1", "ch-2"],
        },
      );

      expect(deletedCount).toBe(0);
    });

    test("handles empty activeChannelIds (returns 0)", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await ChatOpsChannelBindingModel.ensureChannelsExist({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // Create 5 channels
      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-1",
        channelName: "general",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-1",
        channelName: "configured-channel",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        agentId: agent.id,
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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

    test("filters by provider", async ({ makeOrganization, makeUser }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-slack",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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

    test("filters by workspaceId", async ({ makeOrganization, makeUser }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        workspaceName: "Workspace 1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-b",
        channelName: "Bravo",
        workspaceId: "ws-1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // 2 configured, 3 unassigned
      for (let i = 0; i < 5; i++) {
        await ChatOpsChannelBindingModel.create({
          organizationId: org.id,
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
    }) => {
      const org = await makeOrganization();
      const currentUser = await makeUser({ email: "current@example.com" });
      const agent = await makeAgent({ agentType: "agent" });

      // Current user's DM
      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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

    test("returns workspaces list", async ({ makeOrganization, makeUser }) => {
      const org = await makeOrganization();
      const user = await makeUser({ email: "test@example.com" });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
        provider: "slack",
        channelId: "ch-1",
        workspaceId: "ws-1",
        workspaceName: "Workspace 1",
      });

      await ChatOpsChannelBindingModel.create({
        organizationId: org.id,
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
});
