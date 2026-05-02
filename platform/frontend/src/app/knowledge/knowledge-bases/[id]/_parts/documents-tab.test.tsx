import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsTab } from "./documents-tab";

const mockSetPagination = vi.fn();
const mockUpdateQueryParams = vi.fn();
const mockDeleteMutateAsync = vi.fn();
const mockPush = vi.fn();

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const globalWithResizeObserver = globalThis as typeof globalThis & {
  ResizeObserver: typeof ResizeObserver;
};
globalWithResizeObserver.ResizeObserver = ResizeObserver;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/knowledge/knowledge-bases/kb-1",
}));

const mockDocument = {
  id: "doc-1",
  organizationId: "org-1",
  sourceId: "source-1",
  connectorId: "connector-1",
  connectorType: "jira",
  title: "Quarterly Plan",
  contentHash: "hash-1",
  sourceUrl: "https://example.com/quarterly-plan",
  acl: ["org:*"],
  metadata: {},
  embeddingStatus: "completed",
  chunkCount: 2,
  createdAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-04-02T00:00:00.000Z").toISOString(),
};

const mockLongContentDocument = {
  ...mockDocument,
  id: "doc-2",
  title: "Long Doc",
};

vi.mock("@/lib/hooks/use-data-table-query-params", () => ({
  useDataTableQueryParams: () => ({
    searchParams: new URLSearchParams(""),
    pageIndex: 0,
    pageSize: 10,
    offset: 0,
    setPagination: mockSetPagination,
    updateQueryParams: mockUpdateQueryParams,
  }),
}));

vi.mock("@/lib/knowledge/kb-document.query", () => ({
  useKnowledgeBaseDocuments: () => ({
    data: {
      data: [mockDocument, mockLongContentDocument],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
  }),
  useKnowledgeBaseDocument: ({ docId }: { docId: string }) => ({
    data:
      docId === "doc-2"
        ? {
            id: "doc-2",
            content: "a".repeat(25_000),
          }
        : {
            id: "doc-1",
            content: "Detailed content preview",
          },
  }),
  useDeleteKnowledgeBaseDocument: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/lib/knowledge/connector.query", () => ({
  useConnectors: () => ({ data: [], isPending: false }),
}));

describe("DocumentsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutateAsync.mockResolvedValue({ success: true });
  });

  it("renders document list row", () => {
    render(<DocumentsTab knowledgeBaseId="kb-1" />);
    expect(screen.getByText("Quarterly Plan")).toBeInTheDocument();
    expect(screen.getAllByText("jira").length).toBeGreaterThan(0);
    expect(screen.getByText("Long Doc")).toBeInTheDocument();
  });

  it("opens preview dialog from row action", async () => {
    const user = userEvent.setup();
    render(<DocumentsTab knowledgeBaseId="kb-1" />);

    await user.click(screen.getAllByLabelText("Preview")[0]);

    expect(screen.getByText("Detailed content preview")).toBeInTheDocument();
  });

  it("shows truncation notice for long document previews", async () => {
    const user = userEvent.setup();
    render(<DocumentsTab knowledgeBaseId="kb-1" />);

    await user.click(screen.getAllByText("Long Doc")[0]);

    expect(screen.getByText(/Preview truncated to/i)).toBeInTheDocument();
  });

  it("deletes document via confirmation dialog", async () => {
    const user = userEvent.setup();
    render(<DocumentsTab knowledgeBaseId="kb-1" />);

    await user.click(screen.getAllByLabelText("Delete")[0]);

    const confirmButtons = await screen.findAllByRole("button", {
      name: "Delete Document",
      hidden: true,
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-1",
        docId: "doc-1",
      });
    });
  });
});
