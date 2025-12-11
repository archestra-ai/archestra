import { describe, expect, test } from "@/test";
import AgentLabelModel from "./agent-label";

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
    test("syncs labels for an agent", async ({ makeAgent }) => {
      const agent = await makeAgent();

      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "region", value: "us-west-2", keyId: "", valueId: "" },
      ]);

      const labels = await AgentLabelModel.getLabelsForAgent(agent.id);

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("environment");
      expect(labels[0].value).toBe("production");
      expect(labels[1].key).toBe("region");
      expect(labels[1].value).toBe("us-west-2");
    });

    test("replaces existing labels when syncing", async ({ makeAgent }) => {
      const agent = await makeAgent();

      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "environment", value: "staging", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "team", value: "engineering", keyId: "", valueId: "" },
      ]);

      const labels = await AgentLabelModel.getLabelsForAgent(agent.id);

      expect(labels).toHaveLength(2);
      expect(labels[0].key).toBe("environment");
      expect(labels[0].value).toBe("production");
      expect(labels[1].key).toBe("team");
      expect(labels[1].value).toBe("engineering");
    });

    test("clears all labels when syncing with empty array", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      await AgentLabelModel.syncAgentLabels(agent.id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent.id, []);

      const labels = await AgentLabelModel.getLabelsForAgent(agent.id);
      expect(labels).toHaveLength(0);
    });
  });

  describe("pruneKeysAndValues", () => {
    test("removes orphaned keys and values", async ({ makeAgent }) => {
      const agent = await makeAgent();

      // Create labels
      await AgentLabelModel.syncAgentLabels(agent.id, [
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
      await AgentLabelModel.syncAgentLabels(agent.id, []);

      // Verify orphaned keys and values were pruned
      keys = await AgentLabelModel.getAllKeys();
      values = await AgentLabelModel.getAllValues();
      expect(keys).not.toContain("environment");
      expect(keys).not.toContain("region");
      expect(values).not.toContain("production");
      expect(values).not.toContain("us-west-2");
    });

    test("keeps keys and values that are still in use", async ({
      makeAgent,
    }) => {
      const { id: agent1Id } = await makeAgent();
      const { id: agent2Id } = await makeAgent();

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
    test("returns all unique keys", async ({ makeAgent }) => {
      const { id: agent1Id } = await makeAgent();
      const { id: agent2Id } = await makeAgent();

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
    test("returns all unique values", async ({ makeAgent }) => {
      const { id: agent1Id } = await makeAgent();
      const { id: agent2Id } = await makeAgent();

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

  describe("getLabelsForAgents", () => {
    test("returns labels for multiple agents in bulk", async ({
      makeAgent,
    }) => {
      const { id: agent1Id } = await makeAgent();
      const { id: agent2Id } = await makeAgent();
      const { id: agent3Id } = await makeAgent();

      await AgentLabelModel.syncAgentLabels(agent1Id, [
        { key: "environment", value: "production", keyId: "", valueId: "" },
        { key: "region", value: "us-west-2", keyId: "", valueId: "" },
      ]);

      await AgentLabelModel.syncAgentLabels(agent2Id, [
        { key: "environment", value: "staging", keyId: "", valueId: "" },
      ]);

      // agent3 has no labels

      const labelsMap = await AgentLabelModel.getLabelsForAgents([
        agent1Id,
        agent2Id,
        agent3Id,
      ]);

      expect(labelsMap.size).toBe(3);

      const agent1Labels = labelsMap.get(agent1Id);
      expect(agent1Labels).toHaveLength(2);
      expect(agent1Labels?.[0].key).toBe("environment");
      expect(agent1Labels?.[0].value).toBe("production");
      expect(agent1Labels?.[1].key).toBe("region");
      expect(agent1Labels?.[1].value).toBe("us-west-2");

      const agent2Labels = labelsMap.get(agent2Id);
      expect(agent2Labels).toHaveLength(1);
      expect(agent2Labels?.[0].key).toBe("environment");
      expect(agent2Labels?.[0].value).toBe("staging");

      const agent3Labels = labelsMap.get(agent3Id);
      expect(agent3Labels).toHaveLength(0);
    });

    test("returns empty map for empty agent IDs array", async () => {
      const labelsMap = await AgentLabelModel.getLabelsForAgents([]);
      expect(labelsMap.size).toBe(0);
    });
  });
});
