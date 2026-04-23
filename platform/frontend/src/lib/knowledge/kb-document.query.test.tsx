import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetKnowledgeBaseDocuments = vi.fn();
const mockDeleteKnowledgeBaseDocument = vi.fn();
const mockHandleApiError = vi.fn();
const mockToastSuccess = vi.fn();

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getKnowledgeBaseDocuments: (...args: unknown[]) =>
      mockGetKnowledgeBaseDocuments(...args),
    deleteKnowledgeBaseDocument: (...args: unknown[]) =>
      mockDeleteKnowledgeBaseDocument(...args),
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
  useDeleteKnowledgeBaseDocument,
  useKnowledgeBaseDocuments,
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

  it("fetches knowledge base documents with pagination and search", async () => {
    mockGetKnowledgeBaseDocuments.mockResolvedValue({
      data: {
        data: [
          {
            id: "doc-1",
            connectorId: "connector-1",
            connectorType: "jira",
            organizationId: "org-1",
            sourceId: "source-1",
            title: "Budget Plan",
            content: "content",
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
        useKnowledgeBaseDocuments({
          knowledgeBaseId: "kb-1",
          limit: 10,
          offset: 0,
          search: "budget",
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.data?.data).toHaveLength(1);
    });

    expect(mockGetKnowledgeBaseDocuments).toHaveBeenCalledWith({
      path: { id: "kb-1" },
      query: {
        limit: 10,
        offset: 0,
        search: "budget",
      },
    });
  });

  it("deletes a knowledge base document and invalidates related queries", async () => {
    mockDeleteKnowledgeBaseDocument.mockResolvedValue({
      data: { success: true },
      error: null,
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useDeleteKnowledgeBaseDocument(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({
        knowledgeBaseId: "kb-1",
        docId: "doc-1",
      });
    });

    expect(mockDeleteKnowledgeBaseDocument).toHaveBeenCalledWith({
      path: {
        id: "kb-1",
        docId: "doc-1",
      },
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["knowledge-base-documents", "kb-1"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["knowledge-bases"],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Document deleted successfully",
    );
  });
});
