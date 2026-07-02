import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorDocumentsTable } from "./connector-documents-table";

const mockSetPagination = vi.fn();
const mockUpdateQueryParams = vi.fn();
const mockDeleteMutateAsync = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation");

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
  useConnectorDocuments: () => ({
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
    vi.mocked(useRouter).mockReturnValue({
      push: mockPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams("") as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePathname).mockReturnValue("/knowledge/connectors/connector-1");
    mockDeleteMutateAsync.mockResolvedValue({ success: true });
  });

  it("renders document list row", () => {
    render(<ConnectorDocumentsTable connectorId="connector-1" />);
    expect(screen.getByText("Quarterly Plan")).toBeInTheDocument();
    expect(screen.queryByText("jira")).not.toBeInTheDocument();
    expect(screen.getByText("Long Doc")).toBeInTheDocument();
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
