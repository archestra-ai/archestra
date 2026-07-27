import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useCreateLimit,
  useDeleteLimit,
  useLimit,
  useLimits,
  useUpdateLimit,
} from "@/lib/limits.query";

vi.mock("sonner");

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getLimits: vi.fn(),
    getLimit: vi.fn(),
    createLimit: vi.fn(),
    updateLimit: vi.fn(),
    deleteLimit: vi.fn(),
  },
}));

const limitRow = {
  id: "limit-1",
  entityType: "agent",
  entityId: "proxy-1",
  limitType: "token_cost",
  limitValue: 100,
  modelUsage: [],
};

/**
 * Mirrors the limits page: the list mounts first, then the by-id query for the
 * `edit` search param — which is absent on a plain page load, so it gets no id.
 * The mount order decides which queryFn a shared cache entry ends up holding.
 *
 * Tests rerender around the mutation because an observer re-applies its options
 * to its query on every render, and the page renders again once the mutation
 * settles — which is when a poisoned cache entry reaches the table.
 */
function renderLimitsPage(editId?: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const { result, rerender } = renderHook(
    () => ({
      list: useLimits(),
      detail: useLimit(editId),
      create: useCreateLimit(),
      update: useUpdateLimit(),
      remove: useDeleteLimit(),
    }),
    { wrapper },
  );
  return { queryClient, result, rerender };
}

describe("limits query cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(archestraApiSdk.getLimits).mockResolvedValue({
      error: undefined,
      data: [limitRow],
    } as never);
  });

  it("gives the list and an id-less detail query separate cache entries", async () => {
    const { queryClient, result } = renderLimitsPage();
    await waitFor(() => expect(result.current.list.data).toEqual([limitRow]));

    expect(queryClient.getQueryCache().getAll()).toHaveLength(2);
  });

  it("keeps the list populated after creating a limit", async () => {
    vi.mocked(archestraApiSdk.createLimit).mockResolvedValue({
      error: undefined,
      data: limitRow,
    } as never);

    const { result, rerender } = renderLimitsPage();
    await waitFor(() => expect(result.current.list.data).toEqual([limitRow]));
    rerender();

    await act(async () => {
      await result.current.create.mutateAsync({} as never);
    });
    rerender();

    expect(result.current.list.data).toEqual([limitRow]);
  });

  it("keeps the list populated after deleting a limit", async () => {
    vi.mocked(archestraApiSdk.deleteLimit).mockResolvedValue({
      error: undefined,
      data: { success: true },
    } as never);

    const { result, rerender } = renderLimitsPage();
    await waitFor(() => expect(result.current.list.data).toEqual([limitRow]));
    rerender();

    await act(async () => {
      await result.current.remove.mutateAsync({ id: limitRow.id });
    });
    rerender();

    expect(result.current.list.data).toEqual([limitRow]);
  });

  it("fetches a limit by id for the edit dialog", async () => {
    vi.mocked(archestraApiSdk.getLimit).mockResolvedValue({
      error: undefined,
      data: limitRow,
    } as never);

    const { result } = renderLimitsPage(limitRow.id);

    await waitFor(() => expect(result.current.detail.data).toEqual(limitRow));
    expect(vi.mocked(archestraApiSdk.getLimit)).toHaveBeenCalledWith({
      path: { id: limitRow.id },
    });
  });

  it("keeps the list populated after updating a limit being edited", async () => {
    vi.mocked(archestraApiSdk.getLimit).mockResolvedValue({
      error: undefined,
      data: limitRow,
    } as never);
    vi.mocked(archestraApiSdk.updateLimit).mockResolvedValue({
      error: undefined,
      data: { ...limitRow, limitValue: 250 },
    } as never);

    const { result, rerender } = renderLimitsPage(limitRow.id);
    await waitFor(() => expect(result.current.list.data).toEqual([limitRow]));
    rerender();

    await act(async () => {
      await result.current.update.mutateAsync({
        id: limitRow.id,
        limitValue: 250,
      });
    });
    rerender();

    expect(result.current.list.data).toEqual([limitRow]);
  });
});
