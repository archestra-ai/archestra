import { BUILT_IN_AGENT_IDS } from "@archestra/shared";
import { expect, test } from "@/test";
import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";

test("startup tool preflight returns only live ordinary agents with missing assignments", async ({
  makeOrganization,
  makeAgent,
  makeTool,
}) => {
  const org = await makeOrganization();
  const first = await makeTool();
  const second = await makeTool();
  const complete = await makeAgent({ organizationId: org.id });
  const partial = await makeAgent({ organizationId: org.id });
  const missing = await makeAgent({
    organizationId: org.id,
    agentType: "mcp_gateway",
  });
  const deleted = await makeAgent({ organizationId: org.id });
  const builtIn = await makeAgent({
    organizationId: org.id,
    builtInAgentConfig: { name: BUILT_IN_AGENT_IDS.OPENAPPA_CONFIG },
  });
  const otherOrg = await makeAgent();
  const toolIds = [first.id, second.id];
  await AgentToolModel.createManyIfNotExists(complete.id, toolIds);
  await AgentToolModel.createManyIfNotExists(partial.id, [first.id]);
  await AgentModel.delete(deleted.id);

  expect(
    await AgentModel.findNonBuiltInIdsMissingToolAssignments({
      organizationId: org.id,
      toolIds: [],
    }),
  ).toEqual([]);
  const candidates = await AgentModel.findNonBuiltInIdsMissingToolAssignments({
    organizationId: org.id,
    toolIds,
  });
  expect(candidates.sort()).toEqual([partial.id, missing.id].sort());
  for (const agentId of candidates) {
    await AgentToolModel.createManyIfNotExists(agentId, toolIds);
  }
  expect(
    await AgentModel.findNonBuiltInIdsMissingToolAssignments({
      organizationId: org.id,
      toolIds,
    }),
  ).toEqual([]);
  for (const agentId of [complete.id, partial.id, missing.id]) {
    expect(await AgentToolModel.findToolIdsByAgent(agentId)).toEqual(
      expect.arrayContaining(toolIds),
    );
  }
  for (const agentId of [deleted.id, builtIn.id, otherOrg.id]) {
    expect(await AgentToolModel.findToolIdsByAgent(agentId)).not.toEqual(
      expect.arrayContaining(toolIds),
    );
  }
});
