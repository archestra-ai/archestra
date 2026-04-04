import { describe, expect, test } from "@/test";
import AgentConnectorAssignmentModel from "./agent-connector-assignment";

describe("AgentConnectorAssignmentModel", () => {
  describe("findByAgent", () => {
    test("returns assignments for a given agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector2.id);

      const results = await AgentConnectorAssignmentModel.findByAgent(agent.id);

      expect(results).toHaveLength(2);
      const connectorIds = results.map((r) => r.connectorId);
      expect(connectorIds).toContain(connector1.id);
      expect(connectorIds).toContain(connector2.id);
    });

    test("returns empty array when agent has no assignments", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const results = await AgentConnectorAssignmentModel.findByAgent(agent.id);

      expect(results).toHaveLength(0);
    });

    test("does not return assignments from other agents", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent1.id, connector.id);
      await AgentConnectorAssignmentModel.assign(agent2.id, connector.id);

      const results = await AgentConnectorAssignmentModel.findByAgent(
        agent1.id,
      );

      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe(agent1.id);
    });
  });

  describe("findByConnector", () => {
    test("returns assignments for a given connector", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent1.id, connector.id);
      await AgentConnectorAssignmentModel.assign(agent2.id, connector.id);

      const results = await AgentConnectorAssignmentModel.findByConnector(
        connector.id,
      );

      expect(results).toHaveLength(2);
      const agentIds = results.map((r) => r.agentId);
      expect(agentIds).toContain(agent1.id);
      expect(agentIds).toContain(agent2.id);
    });

    test("returns empty array when connector has no assignments", async ({
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      const results = await AgentConnectorAssignmentModel.findByConnector(
        connector.id,
      );

      expect(results).toHaveLength(0);
    });

    test("does not return assignments from other connectors", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector2.id);

      const results = await AgentConnectorAssignmentModel.findByConnector(
        connector1.id,
      );

      expect(results).toHaveLength(1);
      expect(results[0].connectorId).toBe(connector1.id);
    });
  });

  describe("assign", () => {
    test("creates an assignment between agent and connector", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

      const results = await AgentConnectorAssignmentModel.findByAgent(agent.id);
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe(agent.id);
      expect(results[0].connectorId).toBe(connector.id);
      expect(results[0].createdAt).toBeDefined();
    });

    test("does not duplicate on conflict", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector.id);
      // Should not throw on duplicate
      await AgentConnectorAssignmentModel.assign(agent.id, connector.id);

      const results = await AgentConnectorAssignmentModel.findByAgent(agent.id);
      expect(results).toHaveLength(1);
    });
  });

  describe("unassign", () => {
    test("removes an assignment so it is no longer found", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector.id);
      await AgentConnectorAssignmentModel.unassign(agent.id, connector.id);

      // Verify assignment is gone (PGlite may not return accurate rowCount)
      const remaining = await AgentConnectorAssignmentModel.findByAgent(
        agent.id,
      );
      expect(remaining).toHaveLength(0);
    });

    test("does not throw when assignment does not exist", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      // Should not throw; PGlite rowCount behavior may vary
      await AgentConnectorAssignmentModel.unassign(agent.id, connector.id);
    });

    test("only removes the specified assignment", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector2.id);

      await AgentConnectorAssignmentModel.unassign(agent.id, connector1.id);

      const remaining = await AgentConnectorAssignmentModel.findByAgent(
        agent.id,
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0].connectorId).toBe(connector2.id);
    });
  });

  describe("unassignAllFromAgent", () => {
    test("removes all assignments for an agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector3 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector2.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector3.id);

      await AgentConnectorAssignmentModel.unassignAllFromAgent(agent.id);

      // Verify all assignments are gone (PGlite may not return accurate rowCount)
      const remaining = await AgentConnectorAssignmentModel.findByAgent(
        agent.id,
      );
      expect(remaining).toHaveLength(0);
    });

    test("does not throw when agent has no assignments", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      // Should not throw; PGlite rowCount behavior may vary
      await AgentConnectorAssignmentModel.unassignAllFromAgent(agent.id);
    });

    test("does not affect assignments from other agents", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent1.id, connector.id);
      await AgentConnectorAssignmentModel.assign(agent2.id, connector.id);

      await AgentConnectorAssignmentModel.unassignAllFromAgent(agent1.id);

      const agent2Assignments = await AgentConnectorAssignmentModel.findByAgent(
        agent2.id,
      );
      expect(agent2Assignments).toHaveLength(1);
    });
  });

  describe("getConnectorIds", () => {
    test("returns connector IDs for a given agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent.id, connector2.id);

      const connectorIds = await AgentConnectorAssignmentModel.getConnectorIds(
        agent.id,
      );

      expect(connectorIds).toHaveLength(2);
      expect(connectorIds).toContain(connector1.id);
      expect(connectorIds).toContain(connector2.id);
    });

    test("returns empty array when agent has no assignments", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const connectorIds = await AgentConnectorAssignmentModel.getConnectorIds(
        agent.id,
      );

      expect(connectorIds).toHaveLength(0);
    });

    test("does not include connector IDs from other agents", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
      makeKnowledgeBaseConnector,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);
      const connector1 = await makeKnowledgeBaseConnector(kb.id, org.id);
      const connector2 = await makeKnowledgeBaseConnector(kb.id, org.id);

      await AgentConnectorAssignmentModel.assign(agent1.id, connector1.id);
      await AgentConnectorAssignmentModel.assign(agent2.id, connector2.id);

      const connectorIds = await AgentConnectorAssignmentModel.getConnectorIds(
        agent1.id,
      );

      expect(connectorIds).toHaveLength(1);
      expect(connectorIds).toContain(connector1.id);
      expect(connectorIds).not.toContain(connector2.id);
    });
  });
});
