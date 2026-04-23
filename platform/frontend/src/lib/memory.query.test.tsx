import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import {
  memoryKeys,
  useCreateMemory,
  useMemory,
  useMemoryPaginated,
  usePendingMemoryPaginated,
  useUpdateMemoryCandidate,
} from "./memory.query";

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      listMemory: vi.fn(),
      listPendingMemory: vi.fn(),
      getMemory: vi.fn(),
      getMemoryStats: vi.fn(),
      createMemory: vi.fn(),
      updateMemory: vi.fn(),
      supersedeMemory: vi.fn(),
      approveMemory: vi.fn(),
      rejectMemory: vi.fn(),
      archiveMemory: vi.fn(),
      unarchiveMemory: vi.fn(),
      deleteMemory: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("memory.query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns EMPTY memory list fallback when listMemory fails", async () => {
    vi.mocked(archestraApiSdk.listMemory).mockResolvedValue({
      data: undefined,
      error: { error: { message: "boom", type: "api_internal_server_error" } },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.listMemory>>);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { result } = renderHook(
      () => useMemoryPaginated({ limit: 10, offset: 0, status: "approved" }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({
      data: [],
      pagination: {
        currentPage: 1,
        limit: 50,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
    expect(handleApiError).toHaveBeenCalledTimes(1);
  });

  it("returns EMPTY pending list fallback when listPendingMemory fails", async () => {
    vi.mocked(archestraApiSdk.listPendingMemory).mockResolvedValue({
      data: undefined,
      error: { error: { message: "boom", type: "api_internal_server_error" } },
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.listPendingMemory>
    >);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { result } = renderHook(
      () => usePendingMemoryPaginated({ limit: 5, offset: 0 }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({
      data: [],
      pagination: {
        currentPage: 1,
        limit: 50,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    });
    expect(handleApiError).toHaveBeenCalledTimes(1);
  });

  it("returns null when useMemory getMemory fails", async () => {
    vi.mocked(archestraApiSdk.getMemory).mockResolvedValue({
      data: undefined,
      error: {
        error: { message: "not found", type: "api_internal_server_error" },
      },
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getMemory>>);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    const { result } = renderHook(() => useMemory("memory-1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toBeNull();
    expect(handleApiError).toHaveBeenCalledTimes(1);
  });

  it("invalidates list/pending/stats caches after successful create", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.invalidateQueries = invalidateQueries;

    vi.mocked(archestraApiSdk.createMemory).mockResolvedValue({
      data: {
        id: "memory-created",
      },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.createMemory>>);

    const { result } = renderHook(() => useCreateMemory(), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.mutateAsync({
      scopeType: "user",
      scopeId: "user-1",
      kind: "preference",
      content: "remember this",
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memoryKeys.listPrefix(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memoryKeys.pendingListPrefix(),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memoryKeys.stats(),
    });
  });

  it("invalidates detail cache for updated item", async () => {
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.invalidateQueries = invalidateQueries;

    vi.mocked(archestraApiSdk.updateMemory).mockResolvedValue({
      data: {
        id: "memory-1",
      },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.updateMemory>>);

    const { result } = renderHook(() => useUpdateMemoryCandidate(), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.mutateAsync({
      id: "memory-1",
      body: { content: "updated" },
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: memoryKeys.detail("memory-1"),
    });
  });
});
