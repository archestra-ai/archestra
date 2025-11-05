import db, { schema } from "@/database";
import AgentLabelModel from "./agent-label";

async function createTestAgent(): Promise<string> {
  const agentId = crypto.randomUUID();
  await db.insert(schema.agentsTable).values({
    id: agentId,
    name: `Test Agent ${agentId.substring(0, 8)}`,
  });
  return agentId;
}

describe("AgentLabelModel", () => {
  describe("getOrCreateKey", () => {
    test("creates a new key when it does not exist", async () => {
      const keyId = await AgentLabelModel.getOrCreateKey("environment");

      expect(keyId).toBeDefined();

      const keys = await AgentLabelModel.getAllKeys();
      expect(keys).toContain("environment");
    });

    test("returns existing key ID when key already exists", async () => {
      const keyId1 = await AgentLabelModel.getOrCreateKey("region");
      const keyId2 = await AgentLabelModel.getOrCreateKey("region");

      expect(keyId1).toBe(keyId2);

      const keys = await AgentLabelModel.getAllKeys();
      expect(keys.filter((k) => k === "region")).toHaveLength(1);
    });
  });

  describe("getOrCreateValue", () => {
    test("creates a new value when it does not exist", async () => {
      const valueId = await AgentLabelModel.getOrCreateValue("production");

      expect(valueId).toBeDefined();

      const values = await AgentLabelModel.getAllValues();
      expect(values).toContain("production");
    });

    test("returns existing value ID when value already exists", async () => {
      const valueId1 = await AgentLabelModel.getOrCreateValue("staging");
      const valueId2 = await AgentLabelModel.getOrCreateValue("staging");

      expect(valueId1).toBe(valueId2);

      const values = await AgentLabelModel.getAllValues();
      expect(values.filter((v) => v === "staging")).toHaveLength(1);
    });
  });

  describe("syncAgentLabels", () => {
    test("syncs labels for an agent", async () => {
      const agentId = await createTestAgent();

      await AgentLabelModel.syncAgentLabels(agentId, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "region", value: "us-west-2", keyId: "", valueId: "" },
      ]);

      const labels = await AgentLabelModel.getLabelsForAgent(agentId);

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("environment");
      expect(labels[0].value).toBe("production");
      expect(labels[1].key).toBe("region");
      expect(labels[1].value).toBe("us-west-2");
    });

    test("replaces existing labels when syncing", async () => {
      const agentId = await createTestAgent();

      await AgentLabelModel.syncAgentLabels(agentId, [
        { key: "environment", value: "staging", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agentId, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "team", value: "engineering", keyId: "", valueId: "" },
      ]);

      const labels = await AgentLabelModel.getLabelsForAgent(agentId);

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("environment");
      expect(labels[0].value).toBe("production");
      expect(labels[1].key).toBe("team");
      expect(labels[1].value).toBe("engineering");
    });

    test("clears all labels when syncing with empty array", async () => {
      const agentId = await createTestAgent();

      await AgentLabelModel.syncAgentLabels(agentId, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agentId, []);

      const labels = await AgentLabelModel.getLabelsForAgent(agentId);
      expect(labels).toHaveLength(0);
    });
  });

  describe("pruneKeysAndValues", () => {
    test("removes orphaned keys and values", async () => {
      const agentId = await createTestAgent();

      // Create labels
      await AgentLabelModel.syncAgentLabels(agentId, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "region", value: "us-west-2", keyId: "", valueId: "" },
      ]);

      // Verify keys and values exist
      let keys = await AgentLabelModel.getAllKeys();
      let values = await AgentLabelModel.getAllValues();
      expect(keys).toContain("environment");
      expect(keys).toContain("region");
      expect(values).toContain("production");
      expect(values).toContain("us-west-2");

      // Remove all labels, which should make keys and values orphaned
      await AgentLabelModel.syncAgentLabels(agentId, []);

      // Verify orphaned keys and values were pruned
      keys = await AgentLabelModel.getAllKeys();
      values = await AgentLabelModel.getAllValues();
      expect(keys).not.toContain("environment");
      expect(keys).not.toContain("region");
      expect(values).not.toContain("production");
      expect(values).not.toContain("us-west-2");
    });

    test("keeps keys and values that are still in use", async () => {
      const agent1Id = await createTestAgent();
      const agent2Id = await createTestAgent();

      // Create labels for two agents with shared key/value
      await AgentLabelModel.syncAgentLabels(agent1Id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent2Id, [
        { key: "environment", value: "staging", keyId: "", valueId: "" },
      ]);

      // Remove labels from agent1
      await AgentLabelModel.syncAgentLabels(agent1Id, []);

      // Verify "environment" key is still present (used by agent2)
      const keys = await AgentLabelModel.getAllKeys();
      expect(keys).toContain("environment");

      // Verify "staging" value is still present but "production" is removed
      const values = await AgentLabelModel.getAllValues();
      expect(values).toContain("staging");
      expect(values).not.toContain("production");
    });
  });

  describe("getAllKeys", () => {
    test("returns all unique keys", async () => {
      const agent1Id = await createTestAgent();
      const agent2Id = await createTestAgent();

      await AgentLabelModel.syncAgentLabels(agent1Id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent2Id, [
        { key: "region", value: "us-west-2", keyId: "", valueId: "" },
      ]);

      const keys = await AgentLabelModel.getAllKeys();

      expect(keys).toContain("environment");
      expect(keys).toContain("region");
    });
  });

  describe("getAllValues", () => {
    test("returns all unique values", async () => {
      const agent1Id = await createTestAgent();
      const agent2Id = await createTestAgent();

      await AgentLabelModel.syncAgentLabels(agent1Id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent2Id, [
        { key: "environment", value: "staging", keyId: "", valueId: "" },
      ]);

      const values = await AgentLabelModel.getAllValues();

      expect(values).toContain("production");
      expect(values).toContain("staging");
    });
  });
});
