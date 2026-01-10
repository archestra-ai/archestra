import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import PromptModel from "./prompt";

describe("PromptModel Fix", () => {
  test("update moves prompt history when agentId changes", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // 1. Create two agents
    const agent1 = await AgentModel.create({
      name: "Agent 1",
      teams: [],
    });
    const agent2 = await AgentModel.create({
      name: "Agent 2",
      teams: [],
    });

    // 2. Create a prompt associated with Agent 1
    const prompt = await PromptModel.create(org.id, {
      name: "Test Prompt",
      agentId: agent1.id,
      userPrompt: "Hello",
    });

    expect(prompt.version).toBe(1);
    expect(prompt.agentId).toBe(agent1.id);

    // 3. Update the prompt to change agentId to Agent 2
    // This previously caused a 404 because it couldn't find the previous version under the new agentId
    const updatedPrompt = await PromptModel.update(prompt.id, {
      agentId: agent2.id,
    });

    expect(updatedPrompt).not.toBeNull();
    if (!updatedPrompt) return;

    // 4. Verify that the prompt is now associated with Agent 2 and version incremented
    expect(updatedPrompt.agentId).toBe(agent2.id);
    expect(updatedPrompt.version).toBe(2);
    expect(updatedPrompt.name).toBe("Test Prompt");

    // 5. Verify that findVersions returns the history
    const versions = await PromptModel.findVersions(updatedPrompt.id);
    expect(versions).toHaveLength(2);

    // Check versions are correct
    const v2 = versions.find((v) => v.version === 2);
    const v1 = versions.find((v) => v.version === 1);

    expect(v2).toBeDefined();
    expect(v1).toBeDefined();

    expect(v2?.agentId).toBe(agent2.id);
    expect(v1?.agentId).toBe(agent2.id); // History should move to new agent
  });
});
