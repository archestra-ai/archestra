import { describe, expect, it, vi, beforeEach } from "vitest";
import { processMessage } from "./chatops-manager";
import { AgentModel, SessionModel, TeamModel } from "@/models";
import { type ChatOpsMessage } from "@/types/chatops";

vi.mock("@/models", () => ({
  AgentModel: {
    findById: vi.fn(),
    getByMention: vi.fn(),
  },
  SessionModel: {
    getOrCreateChatOpsSession: vi.fn(),
    updateMetadata: vi.fn(),
  },
  TeamModel: {
    getByExternalId: vi.fn(),
  },
}));

vi.mock("./agent-processor", () => ({
  processAgentMessage: vi.fn().mockResolvedValue({ text: "Agent response" }),
}));

describe("ChatOps Manager", () => {
  const mockMessage: ChatOpsMessage = {
    channelId: "C123",
    teamId: "T123",
    userId: "U123",
    text: "Hello @agent",
    ts: "123.456",
    source: "slack",
  };

  const mockTeam = { id: "team-1", organizationId: "org-1" };
  const mockSession = { id: "session-1", metadata: {} };
  const mockAgent = { id: "agent-1", name: "Test Agent" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(TeamModel.getByExternalId).mockResolvedValue(mockTeam as any);
    vi.mocked(SessionModel.getOrCreateChatOpsSession).mockResolvedValue(mockSession as any);
  });

  it("resolves agent via mention and updates session stickiness", async () => {
    vi.mocked(AgentModel.getByMention).mockResolvedValue(mockAgent as any);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);

    const response = await processMessage(mockMessage, {} as any);

    expect(AgentModel.getByMention).toHaveBeenCalledWith("agent", "org-1");
    expect(SessionModel.updateMetadata).toHaveBeenCalledWith("session-1", { agentId: "agent-1" });
    expect(response.text).toBe("Agent response");
  });

  it("uses sticky agent from session if no mention present", async () => {
    const sessionWithAgent = { id: "session-1", metadata: { agentId: "agent-1" } };
    vi.mocked(SessionModel.getOrCreateChatOpsSession).mockResolvedValue(sessionWithAgent as any);
    vi.mocked(AgentModel.findById).mockResolvedValue(mockAgent as any);

    const messageNoMention: ChatOpsMessage = { ...mockMessage, text: "Hello again" };
    const response = await processMessage(messageNoMention, {} as any);

    expect(AgentModel.getByMention).not.toHaveBeenCalled();
    expect(AgentModel.findById).toHaveBeenCalledWith("agent-1");
    expect(response.text).toBe("Agent response");
  });
});
