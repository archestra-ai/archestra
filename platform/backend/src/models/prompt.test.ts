import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import PromptModel from "./prompt";

describe("PromptModel", () => {
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
    expect(versions).not.toBeNull();
    if (!versions) return;

    // Current should be version 2
    expect(versions.current.version).toBe(2);
    expect(versions.current.agentId).toBe(agent2.id);

    // History should contain version 1
    expect(versions.history).toHaveLength(1);
    const v1 = versions.history.find((h) => h.version === 1);
    expect(v1).toBeDefined();
  });

  test("create persists incoming email settings", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });

    const prompt = await PromptModel.create(org.id, {
      name: "Email Test Prompt",
      agentId: agent.id,
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "internal",
      incomingEmailAllowedDomain: "example.com",
    });

    expect(prompt.incomingEmailEnabled).toBe(true);
    expect(prompt.incomingEmailSecurityMode).toBe("internal");
    expect(prompt.incomingEmailAllowedDomain).toBe("example.com");

    // Verify by re-fetching
    const fetched = await PromptModel.findById(prompt.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.incomingEmailEnabled).toBe(true);
    expect(fetched?.incomingEmailSecurityMode).toBe("internal");
    expect(fetched?.incomingEmailAllowedDomain).toBe("example.com");
  });

  test("update persists incoming email settings", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });

    // Create with defaults
    const prompt = await PromptModel.create(org.id, {
      name: "Email Test Prompt",
      agentId: agent.id,
    });

    expect(prompt.incomingEmailEnabled).toBe(false);
    expect(prompt.incomingEmailSecurityMode).toBe("private");

    // Update to enable email
    const updated = await PromptModel.update(prompt.id, {
      incomingEmailEnabled: true,
      incomingEmailSecurityMode: "public",
    });

    expect(updated).not.toBeNull();
    expect(updated?.incomingEmailEnabled).toBe(true);
    expect(updated?.incomingEmailSecurityMode).toBe("public");

    // Verify by re-fetching
    const fetched = await PromptModel.findById(prompt.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.incomingEmailEnabled).toBe(true);
    expect(fetched?.incomingEmailSecurityMode).toBe("public");
  });

  test("update can toggle email enabled from true to false", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await AgentModel.create({ name: "Test Agent", teams: [] });

    // Create with email enabled
    const prompt = await PromptModel.create(org.id, {
      name: "Email Test Prompt",
      agentId: agent.id,
      incomingEmailEnabled: true,
    });

    expect(prompt.incomingEmailEnabled).toBe(true);

    // Update to disable email
    const updated = await PromptModel.update(prompt.id, {
      incomingEmailEnabled: false,
    });

    expect(updated).not.toBeNull();
    expect(updated?.incomingEmailEnabled).toBe(false);

    // Verify by re-fetching
    const fetched = await PromptModel.findById(prompt.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.incomingEmailEnabled).toBe(false);
  });
});
