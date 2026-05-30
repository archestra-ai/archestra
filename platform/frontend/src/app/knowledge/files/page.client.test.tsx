import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

vi.mock("@/app/knowledge/_parts/knowledge-page-layout", () => ({
  KnowledgePageLayout: ({
    title,
    description,
    createLabel,
    onCreateClick,
    children,
  }: {
    title: string;
    description: string;
    createLabel: string;
    onCreateClick: () => void;
    children: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
      <button type="button" onClick={onCreateClick}>
        {createLabel}
      </button>
      {children}
    </div>
  ),
}));

vi.mock("@/lib/knowledge/knowledge-files.query", () => ({
  formatFileSize: (bytes: number) => `${bytes} B`,
  useDeleteKnowledgeFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useKnowledgeFilesPaginated: () => ({
    data: {
      data: [
        {
          id: "file-1",
          connectorId: "connector-1",
          originalName: "runbook.md",
          mimeType: "text/markdown",
          fileSize: 42,
          contentHash: "hash",
          createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
          processingStatus: "completed",
          processingError: null,
          embeddingStatus: "completed",
          visibility: "personal",
          teamIds: [],
          assignedAgents: [
            { id: "agent-1", name: "Support", agentType: "agent" },
            {
              id: "gateway-1",
              name: "My Gateway",
              agentType: "mcp_gateway",
            },
            {
              id: "agent-2",
              name: "Hidden Assistant",
              agentType: "agent",
            },
            {
              id: "gateway-2",
              name: "Hidden Gateway",
              agentType: "mcp_gateway",
            },
          ],
        },
      ],
      pagination: {
        currentPage: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
    isFetching: false,
  }),
  useKnowledgeFileUploadConfig: () => ({
    data: { maxFileSizeBytes: 10485760 },
  }),
  useUpdateKnowledgeFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadKnowledgeFiles: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/lib/agent.query", () => ({
  useProfiles: () => ({ data: [] }),
}));

vi.mock("@/lib/teams/team.query", () => ({
  useTeams: () => ({ data: [] }),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useMissingPermissions: () => [],
}));

import KnowledgeFilesPage from "./page.client";

describe("KnowledgeFilesPage", () => {
  it("renders uploaded files with their assigned agents", () => {
    render(<KnowledgeFilesPage />);

    expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload Files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Upload retrieval files, control who can access them, and choose which agents or MCP gateways can query them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("runbook.md")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
    expect(screen.getByText("My Gateway")).toBeInTheDocument();
    expect(screen.getByText("+2 more")).toBeInTheDocument();
    expect(screen.queryByText("Hidden Assistant")).not.toBeInTheDocument();
    expect(screen.queryByText("Hidden Gateway")).not.toBeInTheDocument();
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    expect(screen.queryByText("42 B")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download" }),
    ).toBeInTheDocument();
  });

  it("opens the upload dialog from the create button", async () => {
    const user = userEvent.setup();
    render(<KnowledgeFilesPage />);

    await user.click(screen.getByRole("button", { name: "Upload Files" }));

    expect(
      screen.getByRole("dialog", { name: "Upload Files" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: /Drop files here or click to browse/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Agents / MCP Gateways")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Choose which agents and MCP gateways can retrieve this file, or make it available to all of them.",
      ),
    ).toBeInTheDocument();
  });
});
