import { expect, test } from "@/test";
import AgentSuggestedPromptModel from "./agent-suggested-prompt";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

test("large UUID and policy-scope batches retain matching data and ignore unknown IDs", async ({
  makeAgent,
}) => {
  const agent = await makeAgent({ agentType: "agent" });
  const unrelated = await makeAgent();
  const prompts = [{ summaryTitle: "Start", prompt: "Explain the next step." }];
  await AgentSuggestedPromptModel.syncForAgent({ agentId: agent.id, prompts });
  await AgentSuggestedPromptModel.syncForAgent({
    agentId: unrelated.id,
    prompts: [{ summaryTitle: "Other", prompt: "Unrelated" }],
  });
  // More IDs than the wire protocol can bind separately, without creating a
  // huge fixture database. Duplicate inputs still identify one resource.
  const ids: string[] = Array.from({ length: 65_536 }, () =>
    crypto.randomUUID(),
  );
  ids.push(agent.id, agent.id);
  const found = await AgentSuggestedPromptModel.getForAgents(ids);
  expect([...found]).toEqual([[agent.id, prompts]]);
  const audiences = await ResourcePermissionPolicyModel.findAudiences({
    organizationId: agent.organizationId,
    resource: "agent",
    scopes: ids,
  });
  expect(audiences.get(agent.id)).toEqual(
    (
      await ResourcePermissionPolicyModel.findAudiences({
        organizationId: agent.organizationId,
        resource: "agent",
        scopes: [agent.id],
      })
    ).get(agent.id),
  );
  expect(audiences.has(unrelated.id)).toBe(false);
  expect(await AgentSuggestedPromptModel.getForAgents([])).toEqual(new Map());
});
