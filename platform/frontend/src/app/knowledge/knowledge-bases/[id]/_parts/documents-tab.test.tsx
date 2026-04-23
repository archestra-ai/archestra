import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsTab } from "./documents-tab";

const mockSetPagination = vi.fn();
const mockUpdateQueryParams = vi.fn();
const mockDeleteMutateAsync = vi.fn();

const mockDocument = {
  id: "doc-1",
  organizationId: "org-1",
  sourceId: "source-1",
  connectorId: "connector-1",
  connectorType: "jira",
  title: "Quarterly Plan",
  content: "Detailed content preview",
  contentHash: "hash-1",
  sourceUrl: "https://example.com/quarterly-plan",
  acl: ["org:*"],
  metadata: {},
  embeddingStatus: "completed",
  chunkCount: 2,
  createdAt: new Date("2026-04-01T00:00:00.000Z").toISOString(),
  updatedAt: new Date("2026-04-02T00:00:00.000Z").toISOString(),
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
      data: [mockDocument],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
  }),
  useDeleteKnowledgeBaseDocument: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}));

describe("DocumentsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutateAsync.mockResolvedValue({ success: true });
  });

  it("renders document list row", () => {
    render(<DocumentsTab knowledgeBaseId="kb-1" />);
    expect(screen.getByText("Quarterly Plan")).toBeInTheDocument();
    expect(screen.getByText("jira")).toBeInTheDocument();
  });

  it("opens preview dialog from row action", async () => {
    const user = userEvent.setup();
    render(<DocumentsTab knowledgeBaseId="kb-1" />);

    await user.click(screen.getByTitle("Preview document"));

    expect(screen.getByText("Detailed content preview")).toBeInTheDocument();
    expect(
      screen.getByText("Preview raw indexed document content."),
    ).toBeInTheDocument();
  });

  it("deletes document via confirmation dialog", async () => {
    const user = userEvent.setup();
    render(<DocumentsTab knowledgeBaseId="kb-1" />);

    await user.click(screen.getByTitle("Delete document"));
    await user.click(
      screen.getAllByRole("button", { name: "Delete Document" })[1],
    );

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith({
        knowledgeBaseId: "kb-1",
        docId: "doc-1",
      });
    });
  });
});
