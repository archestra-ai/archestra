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

      // Create a bound channel
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
});
