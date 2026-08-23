import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  updatePlugin: vi.fn(),
  deletePlugin: vi.fn(),
}));

vi.mock("@archestra/shared", () => ({ archestraApiSdk: sdk }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import {
  useBulkDeletePlugins,
  useBulkUpdatePluginVisibility,
} from "./plugin.query";

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { mutations: { retry: false } },
      }),
    },
    children,
  );
}

describe("Plugin bulk mutations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies one visibility change through each existing Plugin endpoint", async () => {
    sdk.updatePlugin.mockResolvedValue({ data: {}, error: undefined });
    const { result } = renderHook(() => useBulkUpdatePluginVisibility(), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({
        plugins: [
          { id: "p1", name: "One" },
          { id: "p2", name: "Two" },
        ],
        scope: "org",
        teamIds: [],
        userIds: [],
      }),
    );

    expect(sdk.updatePlugin).toHaveBeenCalledTimes(2);
    expect(sdk.updatePlugin).toHaveBeenCalledWith({
      path: { id: "p1" },
      body: { scope: "org", teamIds: [], userIds: [] },
    });
  });

  it("reports partial delete outcomes without stranding successful rows", async () => {
    sdk.deletePlugin
      .mockResolvedValueOnce({ data: { success: true }, error: undefined })
      .mockResolvedValueOnce({ data: undefined, error: { message: "failed" } });
    const { result } = renderHook(() => useBulkDeletePlugins(), { wrapper });

    const outcome = await act(() =>
      result.current.mutateAsync([
        { id: "p1", name: "One" },
        { id: "p2", name: "Two" },
      ]),
    );

    expect(outcome.succeeded).toEqual([{ id: "p1", name: "One" }]);
    expect(outcome.failed).toHaveLength(1);
  });
});
