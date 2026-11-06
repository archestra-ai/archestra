import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import AgentModel from "./agent";
import AgentToolModel from "./agent-tool";
import { onAgentToolSurfaceChange } from "./agent-tool-surface";

describe("agent tool surface notices", () => {
  // What the chat MCP client listens to, to drop an agent's cached clients.
  const surfaceChanged = vi.fn();
  let stopListening: () => void = () => {};

  beforeEach(() => {
    surfaceChanged.mockClear();
    stopListening = onAgentToolSurfaceChange(surfaceChanged);
  });

  afterEach(() => {
    stopListening();
  });

  test("renaming a sub-agent notifies the agents that delegate to it", async ({
    makeAgent,
  }) => {
    const parent = await makeAgent({ agentType: "agent" });
    const child = await makeAgent({ agentType: "agent" });
    await AgentToolModel.assignDelegation({
      agentId: parent.id,
      targetAgentId: child.id,
    });

    await AgentModel.update(child.id, { name: `${child.name} renamed` });

    expect(surfaceChanged).toHaveBeenCalledWith(parent.id);
  });

  test("changing how tools are exposed notifies the agent itself", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      agentType: "agent",
      toolExposureMode: "full",
    });

    await AgentModel.update(agent.id, {
      toolExposureMode: "search_and_run_only",
    });

    expect(surfaceChanged).toHaveBeenCalledWith(agent.id);
  });

  test("an edit that leaves the tool surface alone notifies no one", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ agentType: "agent" });

    await AgentModel.update(agent.id, { description: "Another description" });

    expect(surfaceChanged).not.toHaveBeenCalled();
  });

  test("a listener that stopped hears nothing", async ({ makeAgent }) => {
    const agent = await makeAgent({
      agentType: "agent",
      toolExposureMode: "full",
    });
    stopListening();

    await AgentModel.update(agent.id, {
      toolExposureMode: "search_and_run_only",
    });

    expect(surfaceChanged).not.toHaveBeenCalled();
  });
});
