import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorDocumentsTable } from "./connector-documents-table";

const mockSetPagination = vi.fn();
const mockUpdateQueryParams = vi.fn();
const mockDeleteMutateAsync = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/knowledge/connectors/connector-1",
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

const mockFailedDocument = {
  ...mockDocument,
  id: "doc-3",
  title: "Failed Doc",
  embeddingStatus: "failed",
  embeddingErrorCode: "rate_limit",
  embeddingErrorDetail: "Rate limit exceeded",
};

const mockProcessingDocument = {
  ...mockDocument,
  id: "doc-4",
  title: "Processing Doc",
  embeddingStatus: "processing",
};

const mockPendingDocument = {
  ...mockDocument,
  id: "doc-5",
  title: "Pending Doc",
  embeddingStatus: "pending",
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
  useConnectorDocuments: () => ({
    data: {
      data: [
        mockDocument,
        mockLongContentDocument,
        mockFailedDocument,
        mockProcessingDocument,
        mockPendingDocument,
      ],
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 5,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
    isPending: false,
  }),
  useConnectorDocument: ({ path }: { path: { docId: string } }) => ({
    data:
      path.docId === "doc-2"
        ? {
            id: "doc-2",
            content: "a".repeat(25_000),
          }
        : {
            id: "doc-1",
            content: "Detailed content preview",
          },
  }),
  useDeleteConnectorDocument: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
}));

describe("ConnectorDocumentsTable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutateAsync.mockResolvedValue({ success: true });
  });

  it("renders document list row", () => {
    render(<ConnectorDocumentsTable connectorId="connector-1" />);
    expect(screen.getByText("Quarterly Plan")).toBeInTheDocument();
    expect(screen.queryByText("jira")).not.toBeInTheDocument();
    expect(screen.getByText("Long Doc")).toBeInTheDocument();
    expect(screen.getByText("Failed Doc")).toBeInTheDocument();
  });

  it("renders correct status badges (Indexed, Failed, Processing, Pending)", () => {
    render(<ConnectorDocumentsTable connectorId="connector-1" />);
    expect(screen.getAllByText("Indexed")[0]).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Processing")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("opens preview dialog from row action", async () => {
    const user = userEvent.setup();
    render(<ConnectorDocumentsTable connectorId="connector-1" />);

    await user.click(screen.getAllByLabelText("Preview")[0]);

    expect(screen.getByText("Detailed content preview")).toBeInTheDocument();
  });

  it("shows truncation notice for long document previews", async () => {
    const user = userEvent.setup();
    render(<ConnectorDocumentsTable connectorId="connector-1" />);

    await user.click(screen.getAllByText("Long Doc")[0]);

    expect(screen.getByText(/Preview truncated to/i)).toBeInTheDocument();
  });

  it("deletes document via confirmation dialog", async () => {
    const user = userEvent.setup();
    render(<ConnectorDocumentsTable connectorId="connector-1" />);

    await user.click(screen.getAllByLabelText("Delete")[0]);

    const confirmButtons = await screen.findAllByRole("button", {
      name: "Delete Document",
      hidden: true,
    });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => {
      expect(mockDeleteMutateAsync).toHaveBeenCalledWith({
        id: "connector-1",
        docId: "doc-1",
      });
    });
  });
});
