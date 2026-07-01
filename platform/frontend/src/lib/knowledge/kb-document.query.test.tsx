import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetConnectorDocuments = vi.fn();
const mockGetConnectorDocument = vi.fn();
const mockDeleteConnectorDocument = vi.fn();
const mockHandleApiError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getConnectorDocuments: (...args: unknown[]) =>
      mockGetConnectorDocuments(...args),
    getConnectorDocument: (...args: unknown[]) =>
      mockGetConnectorDocument(...args),
    deleteConnectorDocument: (...args: unknown[]) =>
      mockDeleteConnectorDocument(...args),
  },
}));

vi.mock("@/lib/utils", () => ({
  handleApiError: (...args: unknown[]) => mockHandleApiError(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

import {
  useConnectorDocument,
  useConnectorDocuments,
  useDeleteConnectorDocument,
} from "./kb-document.query";

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("kb-document query hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches connector documents with pagination and search", async () => {
    mockGetConnectorDocuments.mockResolvedValue({
      data: {
        data: [
          {
            id: "doc-1",
            connectorId: "connector-1",
            connectorType: "jira",
            organizationId: "org-1",
            sourceId: "source-1",
            title: "Budget Plan",
            contentHash: "hash",
            sourceUrl: "https://example.com",
            acl: ["org:*"],
            metadata: {},
            embeddingStatus: "completed",
            chunkCount: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
        pagination: {
          currentPage: 1,
          limit: 10,
          total: 1,
          totalPages: 1,
          hasNext: false,
          hasPrev: false,
        },
      },
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useConnectorDocuments({
          path: { id: "connector-1" },
          query: {
            limit: 10,
            offset: 0,
            search: "budget",
          },
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.data?.data).toHaveLength(1);
    });

    expect(mockGetConnectorDocuments).toHaveBeenCalledWith({
      path: { id: "connector-1" },
      query: {
        limit: 10,
        offset: 0,
        search: "budget",
      },
    });
  });

  it("fetches a connector document detail", async () => {
    mockGetConnectorDocument.mockResolvedValue({
      data: {
        id: "doc-1",
        connectorId: "connector-1",
        connectorType: "jira",
        organizationId: "org-1",
        sourceId: "source-1",
        title: "Budget Plan",
        content: "full content",
        contentHash: "hash",
        sourceUrl: "https://example.com",
        acl: ["org:*"],
        metadata: {},
        embeddingStatus: "completed",
        chunkCount: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { result } = renderHook(
      () =>
        useConnectorDocument({
          path: { id: "connector-1", docId: "doc-1" },
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.data?.content).toBe("full content");
    });

    expect(mockGetConnectorDocument).toHaveBeenCalledWith({
      path: { id: "connector-1", docId: "doc-1" },
    });
  });

  it("deletes a connector document and invalidates related queries", async () => {
    mockDeleteConnectorDocument.mockResolvedValue({
      data: { success: true },
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteConnectorDocument(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "connector-1",
        docId: "doc-1",
      });
    });

    expect(mockDeleteConnectorDocument).toHaveBeenCalledWith({
      path: {
        id: "connector-1",
        docId: "doc-1",
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["connector-documents", "connector-1"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["connectors", "connector-1"],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Document deleted successfully",
    );
  });
});
