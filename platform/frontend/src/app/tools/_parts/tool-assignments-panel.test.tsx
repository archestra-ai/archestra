import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolAssignmentsPanel } from "./tool-assignments-panel";
import type { Tool } from "./types";

const mockUseAllAgentTools = vi.fn();
const mockUnassignMutate = vi.fn();
const mockPatchMutate = vi.fn();

vi.mock("@/lib/agent-tools.query", () => ({
  __esModule: true,
  useAllAgentTools: (...args: Parameters<typeof mockUseAllAgentTools>) =>
    mockUseAllAgentTools(...args),
  useAssignTool: () => ({ mutate: vi.fn() }),
  useUnassignTool: () => ({ mutate: mockUnassignMutate }),
  useAgentToolPatchMutation: () => ({ mutate: mockPatchMutate }),
}));

vi.mock("@/lib/agent.query", () => ({
  useAgents: () => ({ data: [{ id: "agent-1", name: "Agent One" }] }),
}));

vi.mock("@/lib/tool-policy.query", () => ({
  useToolPolicies: () => ({ data: [] }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const baseTool: Tool = {
  id: "tool-1",
  catalogId: null,
  name: "Test Tool",
  description: null,
  parameters: {},
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  agent: { id: "owner", name: "Owner" },
  mcpServer: null,
  assignedAgentsCount: 2,
  policyCount: 1,
};

const assignment = {
  id: "assignment-1",
  credentialSourceMcpServerId: null,
  executionSourceMcpServerId: null,
  createdAt: "2024-01-02T00:00:00.000Z",
  updatedAt: "2024-01-02T00:00:00.000Z",
  agent: { id: "agent-1", name: "Agent One" },
  tool: {
    id: baseTool.id,
    name: baseTool.name,
    description: null,
    parameters: {},
    createdAt: baseTool.createdAt,
    updatedAt: baseTool.updatedAt,
    catalogId: null,
    mcpServerId: null,
    mcpServerName: null,
    mcpServerCatalogId: null,
  },
  toolPolicy: null,
};

const pagination = {
  currentPage: 1,
  limit: 1000,
  total: 1,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
};

describe("ToolAssignmentsPanel", () => {
  beforeEach(() => {
    mockUseAllAgentTools.mockReset();
    mockUnassignMutate.mockReset();
    mockPatchMutate.mockReset();

    mockUseAllAgentTools.mockReturnValue({
      data: { data: [assignment], pagination },
      isLoading: false,
    });
  });

  it("fetches assignments for the tool id without excluding Archestra tools", () => {
    render(<ToolAssignmentsPanel tool={baseTool} />);

    expect(mockUseAllAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          toolId: baseTool.id,
        }),
      }),
    );
    expect(screen.getByText("Agent One")).toBeInTheDocument();
  });

  it("unassigns a profile when the button is clicked", () => {
    render(<ToolAssignmentsPanel tool={baseTool} />);

    fireEvent.click(screen.getByRole("button", { name: /unassign/i }));

    expect(mockUnassignMutate).toHaveBeenCalledWith(
      { agentId: "agent-1", toolId: baseTool.id },
      expect.any(Object),
    );
  });
});
