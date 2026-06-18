import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: {
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}));

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

  describe("upload file staging", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    const makeFile = (name: string, content = "x", lastModified = 1000) =>
      new File([content], name, { type: "text/markdown", lastModified });

    const stageFiles = (input: HTMLInputElement, files: File[]) => {
      Object.defineProperty(input, "files", {
        value: files,
        configurable: true,
      });
      fireEvent.change(input);
    };

    const openUploadDialog = async () => {
      const user = userEvent.setup();
      render(<KnowledgeFilesPage />);
      await user.click(screen.getByRole("button", { name: "Upload Files" }));
      const input = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      return { user, input };
    };

    it("appends newly picked files to the existing selection", async () => {
      const { input } = await openUploadDialog();

      stageFiles(input, [makeFile("first.md")]);
      stageFiles(input, [makeFile("second.md")]);

      expect(screen.getByText("first.md")).toBeInTheDocument();
      expect(screen.getByText("second.md")).toBeInTheDocument();
      expect(screen.getByText("2 / 20")).toBeInTheDocument();
    });

    it("ignores re-picking the identical file", async () => {
      const { input } = await openUploadDialog();

      stageFiles(input, [makeFile("dup.md", "same", 1000)]);
      stageFiles(input, [makeFile("dup.md", "same", 1000)]);

      expect(screen.getAllByText("dup.md")).toHaveLength(1);
      expect(screen.getByText("1 / 20")).toBeInTheDocument();
    });

    it("keeps same-named files that differ in content", async () => {
      const { input } = await openUploadDialog();

      stageFiles(input, [makeFile("notes.md", "first", 1000)]);
      stageFiles(input, [makeFile("notes.md", "second-longer", 2000)]);

      expect(screen.getAllByText("notes.md")).toHaveLength(2);
      expect(screen.getByText("2 / 20")).toBeInTheDocument();
    });

    it("removes a staged file", async () => {
      const { user, input } = await openUploadDialog();

      stageFiles(input, [makeFile("remove-me.md")]);
      await user.click(
        screen.getByRole("button", { name: "Remove remove-me.md" }),
      );

      expect(screen.queryByText("remove-me.md")).not.toBeInTheDocument();
    });

    it("caps the selection at the upload limit", async () => {
      const { input } = await openUploadDialog();

      stageFiles(
        input,
        Array.from({ length: 25 }, (_, index) => makeFile(`file-${index}.md`)),
      );

      expect(screen.getByText("20 / 20")).toBeInTheDocument();
      expect(toast.warning).toHaveBeenCalled();
    });

    it("rejects dropped folders without staging them", async () => {
      await openUploadDialog();
      const dropzone = screen.getByRole("button", {
        name: /Drop files here or click to browse/,
      });

      fireEvent.drop(dropzone, {
        dataTransfer: {
          items: [
            {
              kind: "file",
              webkitGetAsEntry: () => ({ isDirectory: true }),
              getAsFile: () => null,
            },
          ],
          files: [],
        },
      });

      expect(toast.warning).toHaveBeenCalledWith(
        "Folders aren't supported — drop individual files.",
      );
      expect(screen.queryByText("0 / 20")).not.toBeInTheDocument();
    });
  });
});
