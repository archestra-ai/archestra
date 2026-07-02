import {
  ARCHESTRA_MCP_CATALOG_ID,
  getArchestraToolFullName,
  PROJECT_MEMORY_ARCHESTRA_TOOL_SHORT_NAMES,
} from "@archestra/shared";
import { AgentModel, ToolModel } from "@/models";
import { describe, expect, test } from "@/test";

const MEMORY_TOOL_FULL_NAMES = PROJECT_MEMORY_ARCHESTRA_TOOL_SHORT_NAMES.map(
  getArchestraToolFullName,
);

/**
 * The memory tools are a chat surface: they auto-attach to internal chat
 * agents only. Gateway/profile agents are external connection surfaces and
 * must never silently grow mutation tools — they get them via an explicit
 * assignment. Pinned here for both the create-time hook and the seed-time
 * backfill.
 */
describe("project memory tool assignment", () => {
  test("AgentModel.create assigns the memory tools to chat agents only", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const chatAgent = await AgentModel.create(
      {
        organizationId: org.id,
        name: "chat agent",
        agentType: "agent",
        scope: "personal",
      },
      user.id,
    );
    const chatAgentTools = await ToolModel.getMcpToolNamesByAgent(chatAgent.id);
    for (const name of MEMORY_TOOL_FULL_NAMES) {
      expect(chatAgentTools).toContain(name);
    }

    const gateway = await AgentModel.create(
      {
        organizationId: org.id,
        name: "gateway",
        agentType: "mcp_gateway",
        scope: "personal",
      },
      user.id,
    );
    const gatewayTools = await ToolModel.getMcpToolNamesByAgent(gateway.id);
    for (const name of MEMORY_TOOL_FULL_NAMES) {
      expect(gatewayTools).not.toContain(name);
    }
  });

  test("the seed-time backfill reaches existing chat agents but not gateways", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });

    // Agents that predate the tools' introduction (created before seeding).
    const chatAgent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      name: "pre-existing chat agent",
    });
    const gateway = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
      name: "pre-existing gateway",
    });

    const insertedNames = await ToolModel.seedArchestraTools(
      ARCHESTRA_MCP_CATALOG_ID,
    );
    await ToolModel.backfillNewProjectMemoryToolsToChatAgents(insertedNames);

    const chatAgentTools = await ToolModel.getMcpToolNamesByAgent(chatAgent.id);
    for (const name of MEMORY_TOOL_FULL_NAMES) {
      expect(chatAgentTools).toContain(name);
    }
    const gatewayTools = await ToolModel.getMcpToolNamesByAgent(gateway.id);
    for (const name of MEMORY_TOOL_FULL_NAMES) {
      expect(gatewayTools).not.toContain(name);
    }

    // Re-running with no newly created tools is a no-op (idempotent guard).
    await ToolModel.backfillNewProjectMemoryToolsToChatAgents([]);
  });
});
