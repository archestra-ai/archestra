import { expect, test } from "@/test";
import AgentSuggestedPromptModel from "./agent-suggested-prompt";

test("syncForAgent creates suggested prompts", async ({
  makeInternalAgent,
}) => {
  const agent = await makeInternalAgent();

  await AgentSuggestedPromptModel.syncForAgent(agent.id, [
    { summaryTitle: "First", prompt: "Do the first thing" },
    { summaryTitle: "Second", prompt: "Do the second thing" },
  ]);

  const prompts = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(prompts).toHaveLength(2);
  expect(prompts[0]).toEqual({
    summaryTitle: "First",
    prompt: "Do the first thing",
  });
  expect(prompts[1]).toEqual({
    summaryTitle: "Second",
    prompt: "Do the second thing",
  });
});

test("syncForAgent replaces existing prompts", async ({
  makeInternalAgent,
}) => {
  const agent = await makeInternalAgent();

  await AgentSuggestedPromptModel.syncForAgent(agent.id, [
    { summaryTitle: "Old", prompt: "Old prompt" },
  ]);

  await AgentSuggestedPromptModel.syncForAgent(agent.id, [
    { summaryTitle: "New A", prompt: "New prompt A" },
    { summaryTitle: "New B", prompt: "New prompt B" },
  ]);

  const prompts = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(prompts).toHaveLength(2);
  expect(prompts[0].summaryTitle).toBe("New A");
  expect(prompts[1].summaryTitle).toBe("New B");
});

test("syncForAgent with empty array removes all prompts", async ({
  makeInternalAgent,
}) => {
  const agent = await makeInternalAgent();

  await AgentSuggestedPromptModel.syncForAgent(agent.id, [
    { summaryTitle: "Temp", prompt: "Temp prompt" },
  ]);

  await AgentSuggestedPromptModel.syncForAgent(agent.id, []);

  const prompts = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(prompts).toHaveLength(0);
});

test("getForAgents returns prompts for multiple agents", async ({
  makeInternalAgent,
}) => {
  const agent1 = await makeInternalAgent();
  const agent2 = await makeInternalAgent();

  await AgentSuggestedPromptModel.syncForAgent(agent1.id, [
    { summaryTitle: "A1", prompt: "Agent 1 prompt" },
  ]);
  await AgentSuggestedPromptModel.syncForAgent(agent2.id, [
    { summaryTitle: "B1", prompt: "Agent 2 prompt 1" },
    { summaryTitle: "B2", prompt: "Agent 2 prompt 2" },
  ]);

  const map = await AgentSuggestedPromptModel.getForAgents([
    agent1.id,
    agent2.id,
  ]);

  expect(map.get(agent1.id)).toHaveLength(1);
  expect(map.get(agent2.id)).toHaveLength(2);
  expect(map.get(agent2.id)?.[0].summaryTitle).toBe("B1");
  expect(map.get(agent2.id)?.[1].summaryTitle).toBe("B2");
});

test("preserves sort order from array index", async ({ makeInternalAgent }) => {
  const agent = await makeInternalAgent();

  const prompts = [
    { summaryTitle: "Third", prompt: "3" },
    { summaryTitle: "First", prompt: "1" },
    { summaryTitle: "Second", prompt: "2" },
  ];

  await AgentSuggestedPromptModel.syncForAgent(agent.id, prompts);

  const result = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(result.map((r) => r.summaryTitle)).toEqual([
    "Third",
    "First",
    "Second",
  ]);
});

test("AgentModel.create includes suggestedPrompts", async ({
  makeOrganization,
}) => {
  const { default: AgentModel } = await import("./agent");
  const org = await makeOrganization();

  const agent = await AgentModel.create({
    name: "Test Agent With Prompts",
    organizationId: org.id,
    scope: "org",
    teams: [],
    agentType: "agent",
    suggestedPrompts: [{ summaryTitle: "Hello", prompt: "Say hello" }],
  });

  expect(agent.suggestedPrompts).toHaveLength(1);
  expect(agent.suggestedPrompts[0].summaryTitle).toBe("Hello");
});

test("AgentModel.update syncs suggestedPrompts", async ({
  makeInternalAgent,
}) => {
  const { default: AgentModel } = await import("./agent");
  const agent = await makeInternalAgent();

  const updated = await AgentModel.update(agent.id, {
    suggestedPrompts: [{ summaryTitle: "Updated", prompt: "Updated prompt" }],
  });

  expect(updated?.suggestedPrompts).toHaveLength(1);
  expect(updated?.suggestedPrompts[0].summaryTitle).toBe("Updated");
});

test("AgentModel.findById includes suggestedPrompts", async ({
  makeOrganization,
}) => {
  const { default: AgentModel } = await import("./agent");
  const org = await makeOrganization();

  const created = await AgentModel.create({
    name: "Find By ID Test",
    organizationId: org.id,
    scope: "org",
    teams: [],
    agentType: "agent",
    suggestedPrompts: [
      { summaryTitle: "Prompt 1", prompt: "Do thing 1" },
      { summaryTitle: "Prompt 2", prompt: "Do thing 2" },
    ],
  });

  const found = await AgentModel.findById(created.id);
  expect(found?.suggestedPrompts).toHaveLength(2);
  expect(found?.suggestedPrompts[0].summaryTitle).toBe("Prompt 1");
  expect(found?.suggestedPrompts[1].summaryTitle).toBe("Prompt 2");
});

test("AgentModel.findAll includes suggestedPrompts", async ({
  makeOrganization,
}) => {
  const { default: AgentModel } = await import("./agent");
  const org = await makeOrganization();

  await AgentModel.create({
    name: "Agent With Prompts In List",
    organizationId: org.id,
    scope: "org",
    teams: [],
    agentType: "agent",
    suggestedPrompts: [
      { summaryTitle: "List Prompt", prompt: "From list query" },
    ],
  });

  const agents = await AgentModel.findAll();
  const found = agents.find((a) => a.name === "Agent With Prompts In List");
  expect(found?.suggestedPrompts).toHaveLength(1);
  expect(found?.suggestedPrompts[0].summaryTitle).toBe("List Prompt");
});

test("AgentModel.update with empty array clears suggestedPrompts", async ({
  makeOrganization,
}) => {
  const { default: AgentModel } = await import("./agent");
  const org = await makeOrganization();

  const agent = await AgentModel.create({
    name: "Agent To Clear Prompts",
    organizationId: org.id,
    scope: "org",
    teams: [],
    agentType: "agent",
    suggestedPrompts: [
      { summaryTitle: "Will be removed", prompt: "Temporary" },
    ],
  });

  expect(agent.suggestedPrompts).toHaveLength(1);

  const updated = await AgentModel.update(agent.id, {
    suggestedPrompts: [],
  });

  expect(updated?.suggestedPrompts).toHaveLength(0);

  // Verify persistence
  const found = await AgentModel.findById(agent.id);
  expect(found?.suggestedPrompts).toHaveLength(0);
});

test("deleting an agent cascades to delete its suggestedPrompts", async ({
  makeOrganization,
}) => {
  const { default: AgentModel } = await import("./agent");
  const org = await makeOrganization();

  const agent = await AgentModel.create({
    name: "Agent To Delete",
    organizationId: org.id,
    scope: "org",
    teams: [],
    agentType: "agent",
    suggestedPrompts: [
      { summaryTitle: "Orphan check", prompt: "Should be deleted" },
    ],
  });

  // Verify prompts exist
  const prompts = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(prompts).toHaveLength(1);

  // Delete the agent
  await AgentModel.delete(agent.id);

  // Verify prompts are cascade-deleted
  const orphanedPrompts = await AgentSuggestedPromptModel.getForAgent(agent.id);
  expect(orphanedPrompts).toHaveLength(0);
});
