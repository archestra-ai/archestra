import { expect, test } from "@/test";
import AgentModel from "./agent";
import InstanceUsageModel from "./instance-usage";
import LlmProviderApiKeyModel from "./llm-provider-api-key";

test("counts entities across the instance", async ({
  makeOrganization,
  makeUser,
  makeTeam,
  makeAgent,
  makeMcpServer,
}) => {
  const organization = await makeOrganization();
  const before = await InstanceUsageModel.getEntityCounts();

  const user = await makeUser();
  await makeTeam(organization.id, user.id);
  await makeAgent({
    organizationId: organization.id,
    agentType: "mcp_gateway",
  });
  await makeAgent({ organizationId: organization.id, agentType: "llm_proxy" });
  await makeAgent({
    organizationId: organization.id,
    agentType: "agent",
    systemPrompt: "You are a test agent",
  });
  await makeMcpServer();
  // Two keys for the same provider count as one connected provider.
  for (const name of ["first", "second"]) {
    await LlmProviderApiKeyModel.create({
      organizationId: organization.id,
      name,
      provider: "anthropic",
      scope: "org",
    });
  }

  const after = await InstanceUsageModel.getEntityCounts();

  expect(after.users - before.users).toBe(1);
  expect(after.teams - before.teams).toBe(1);
  expect(after.mcpGateways - before.mcpGateways).toBe(1);
  expect(after.llmProxies - before.llmProxies).toBe(1);
  expect(after.agents - before.agents).toBe(1);
  expect(after.mcpServers - before.mcpServers).toBe(1);
  expect(after.llmProviders - before.llmProviders).toBe(1);
});

test("excludes soft-deleted agents", async ({
  makeOrganization,
  makeAgent,
}) => {
  const organization = await makeOrganization();
  const agent = await makeAgent({
    organizationId: organization.id,
    agentType: "mcp_gateway",
  });
  const before = await InstanceUsageModel.getEntityCounts();

  await AgentModel.delete(agent.id);

  const after = await InstanceUsageModel.getEntityCounts();
  expect(before.mcpGateways - after.mcpGateways).toBe(1);
});
