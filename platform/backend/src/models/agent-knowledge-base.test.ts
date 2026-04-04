import { describe, expect, test } from "@/test";
import AgentKnowledgeBaseModel from "./agent-knowledge-base";

describe("AgentKnowledgeBaseModel", () => {
  describe("assign", () => {
    test("assigns a knowledge base to an agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe(agent.id);
      expect(results[0].knowledgeBaseId).toBe(kb.id);
    });

    test("is idempotent (duplicate assign does not throw)", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(1);
    });

    test("assigns multiple knowledge bases to one agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent.id, kb2.id);

      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(2);
    });
  });

  describe("unassign", () => {
    test("removes a knowledge base assignment", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
      const removed = await AgentKnowledgeBaseModel.unassign(agent.id, kb.id);

      expect(removed).toBe(true);
      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(0);
    });

    test("returns false when assignment does not exist", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      const removed = await AgentKnowledgeBaseModel.unassign(agent.id, kb.id);
      expect(removed).toBe(false);
    });

    test("only removes the specified assignment", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent.id, kb2.id);
      await AgentKnowledgeBaseModel.unassign(agent.id, kb1.id);

      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(1);
      expect(results[0].knowledgeBaseId).toBe(kb2.id);
    });
  });

  describe("findByAgent", () => {
    test("returns empty array when agent has no assignments", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toEqual([]);
    });
  });

  describe("findByKnowledgeBase", () => {
    test("returns agents assigned to a knowledge base", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent1.id, kb.id);
      await AgentKnowledgeBaseModel.assign(agent2.id, kb.id);

      const results = await AgentKnowledgeBaseModel.findByKnowledgeBase(kb.id);
      expect(results).toHaveLength(2);
      const agentIds = results.map((r) => r.agentId).sort();
      expect(agentIds).toEqual([agent1.id, agent2.id].sort());
    });

    test("returns empty array when no agents are assigned", async ({
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const kb = await makeKnowledgeBase(org.id);

      const results = await AgentKnowledgeBaseModel.findByKnowledgeBase(kb.id);
      expect(results).toEqual([]);
    });
  });

  describe("syncForAgent", () => {
    test("replaces all assignments for an agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const kb3 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent.id, kb2.id);

      await AgentKnowledgeBaseModel.syncForAgent(agent.id, [kb2.id, kb3.id]);

      const ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id);
      expect(ids.sort()).toEqual([kb2.id, kb3.id].sort());
    });

    test("clears all assignments when given empty array", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);
      await AgentKnowledgeBaseModel.syncForAgent(agent.id, []);

      const ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id);
      expect(ids).toEqual([]);
    });

    test("does not affect other agents", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent1.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent2.id, kb2.id);

      await AgentKnowledgeBaseModel.syncForAgent(agent1.id, []);

      const agent1Ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
        agent1.id,
      );
      const agent2Ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(
        agent2.id,
      );
      expect(agent1Ids).toEqual([]);
      expect(agent2Ids).toEqual([kb2.id]);
    });

    test("handles duplicate IDs gracefully", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.syncForAgent(agent.id, [kb.id, kb.id]);

      const ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id);
      expect(ids).toEqual([kb.id]);
    });
  });

  describe("getKnowledgeBaseIds", () => {
    test("returns knowledge base IDs for an agent", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent.id, kb2.id);

      const ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id);
      expect(ids.sort()).toEqual([kb1.id, kb2.id].sort());
    });

    test("returns empty array for agent with no assignments", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const ids = await AgentKnowledgeBaseModel.getKnowledgeBaseIds(agent.id);
      expect(ids).toEqual([]);
    });
  });

  describe("getKnowledgeBaseIdsForAgents", () => {
    test("batch fetches KB IDs for multiple agents", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const agent3 = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent1.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent1.id, kb2.id);
      await AgentKnowledgeBaseModel.assign(agent2.id, kb2.id);

      const map = await AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents([
        agent1.id,
        agent2.id,
        agent3.id,
      ]);

      expect(map.get(agent1.id)?.sort()).toEqual([kb1.id, kb2.id].sort());
      expect(map.get(agent2.id)).toEqual([kb2.id]);
      expect(map.has(agent3.id)).toBe(false);
    });

    test("returns empty map for empty input", async () => {
      const map = await AgentKnowledgeBaseModel.getKnowledgeBaseIdsForAgents(
        [],
      );
      expect(map.size).toBe(0);
    });
  });

  describe("getAgentIdsForKnowledgeBases", () => {
    test("batch fetches agent IDs for multiple KBs", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({ organizationId: org.id });
      const agent2 = await makeAgent({ organizationId: org.id });
      const kb1 = await makeKnowledgeBase(org.id);
      const kb2 = await makeKnowledgeBase(org.id);
      const kb3 = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent1.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent2.id, kb1.id);
      await AgentKnowledgeBaseModel.assign(agent1.id, kb2.id);

      const map = await AgentKnowledgeBaseModel.getAgentIdsForKnowledgeBases([
        kb1.id,
        kb2.id,
        kb3.id,
      ]);

      expect(map.get(kb1.id)?.sort()).toEqual([agent1.id, agent2.id].sort());
      expect(map.get(kb2.id)).toEqual([agent1.id]);
      expect(map.has(kb3.id)).toBe(false);
    });

    test("returns empty map for empty input", async () => {
      const map = await AgentKnowledgeBaseModel.getAgentIdsForKnowledgeBases(
        [],
      );
      expect(map.size).toBe(0);
    });
  });

  describe("cascade delete", () => {
    test("assignments are deleted when agent is deleted", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

      const { default: AgentModel } = await import("./agent");
      await AgentModel.delete(agent.id);

      const results = await AgentKnowledgeBaseModel.findByKnowledgeBase(kb.id);
      expect(results).toHaveLength(0);
    });

    test("assignments are deleted when knowledge base is deleted", async ({
      makeAgent,
      makeOrganization,
      makeKnowledgeBase,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const kb = await makeKnowledgeBase(org.id);

      await AgentKnowledgeBaseModel.assign(agent.id, kb.id);

      const { default: KnowledgeBaseModel } = await import("./knowledge-base");
      await KnowledgeBaseModel.delete(kb.id);

      const results = await AgentKnowledgeBaseModel.findByAgent(agent.id);
      expect(results).toHaveLength(0);
    });
  });
});
