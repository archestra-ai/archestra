import { beforeEach, describe, expect, test, vi } from "vitest";

const mockFindById = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("@/models", () => ({
  AgentModel: {
    findById: mockFindById,
    update: mockUpdate,
  },
}));

const mockExecuteA2AMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: mockExecuteA2AMessage,
}));

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { handleAgentRun } from "./agent-run-handler";

describe("handleAgentRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("throws error when agentId is missing", async () => {
    await expect(handleAgentRun({})).rejects.toThrow("agentId is required");
  });

  test("does nothing when agent is not found", async () => {
    mockFindById.mockResolvedValue(null);

    await handleAgentRun({ agentId: "non-existent" });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("skips non-internal agents", async () => {
    mockFindById.mockResolvedValue({
      id: "agent-1",
      agentType: "profile",
    });

    await handleAgentRun({ agentId: "agent-1" });

    expect(mockExecuteA2AMessage).not.toHaveBeenCalled();
  });

  test("executes agent run successfully and updates lastScheduledRunAt", async () => {
    const agent = {
      id: "agent-1",
      name: "Test Agent",
      agentType: "agent",
      organizationId: "org-1",
      authorId: "user-1",
      scheduledMessage: "Hello",
    };
    mockFindById.mockResolvedValue(agent);

    await handleAgentRun({ agentId: "agent-1" });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        message: "Hello",
        organizationId: "org-1",
        userId: "user-1",
      }),
    );

    expect(mockUpdate).toHaveBeenCalledWith("agent-1", {
      lastScheduledRunAt: expect.any(Date),
    });
  });

  test("uses fallback message and system user when needed", async () => {
    const agent = {
      id: "agent-1",
      name: "Test Agent",
      agentType: "agent",
      organizationId: "org-1",
      authorId: null,
      scheduledMessage: null,
    };
    mockFindById.mockResolvedValue(agent);

    await handleAgentRun({ agentId: "agent-1" });

    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Run scheduled task",
        userId: "system",
      }),
    );
  });

  test("re-throws error when execution fails", async () => {
    mockFindById.mockResolvedValue({
      id: "agent-1",
      agentType: "agent",
      organizationId: "org-1",
    });
    mockExecuteA2AMessage.mockRejectedValue(new Error("Execution failed"));

    await expect(handleAgentRun({ agentId: "agent-1" })).rejects.toThrow(
      "Execution failed",
    );
    
    // Should NOT update lastScheduledRunAt on failure
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
