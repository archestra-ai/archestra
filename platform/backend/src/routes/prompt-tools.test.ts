import AgentModel from "@/models/agent";
import PromptModel from "@/models/prompt";
import PromptAgentModel from "@/models/prompt-agent";
import ToolModel from "@/models/tool";
import { describe, expect, test } from "@/test";

describe("GET /api/prompts/:id/tools", () => {
  test("returns agent delegation tools for a prompt", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ email: "test@example.com" });
    const team = await makeTeam(org.id, user.id, { name: "Test Team" });

    // Create parent agent and prompt
    const parentAgent = await AgentModel.create({
      name: "Parent Agent",
      teams: [team.id],
    });

    const parentPrompt = await PromptModel.create(org.id, {
      name: "Parent Prompt",
      agentId: parentAgent.id,
    });

    // Create child agent and prompt
    const childAgent = await AgentModel.create({
      name: "Child Agent",
      teams: [team.id],
    });

    const childPrompt = await PromptModel.create(org.id, {
      name: "Child Prompt",
      agentId: childAgent.id,
      systemPrompt: "I am a child agent",
    });

    // Assign child prompt as agent to parent prompt
    await PromptAgentModel.create({
      promptId: parentPrompt.id,
      agentPromptId: childPrompt.id,
    });

    // Verify tool was created
    const tools = await ToolModel.getAgentDelegationToolsByPrompt(
      parentPrompt.id,
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("agent__child_prompt");

    // Verify the detailed query also works
    const toolsWithDetails = await ToolModel.getAgentDelegationToolsWithDetails(
      parentPrompt.id,
    );
    expect(toolsWithDetails).toHaveLength(1);
    expect(toolsWithDetails[0].profileId).toBe(childAgent.id);
  });
});
