import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  updatePlugin: vi.fn(),
  deletePlugin: vi.fn(),
  importGithubPluginMarketplace: vi.fn(),
}));

vi.mock("@archestra/shared", () => ({ archestraApiSdk: sdk }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import {
  type ImportGithubPluginMarketplaceBody,
  useBulkDeletePlugins,
  useBulkUpdatePluginVisibility,
  useImportGithubPluginMarketplace,
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

  it("names the failed plugins and their reasons in the import toast", async () => {
    sdk.importGithubPluginMarketplace.mockResolvedValue({
      data: {
        created: [{ id: "p0" }],
        failed: [
          { name: "one", error: "first reason" },
          { name: "two", error: "second reason" },
        ],
      },
      error: undefined,
    });
    const { result } = renderHook(() => useImportGithubPluginMarketplace(), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({} as ImportGithubPluginMarketplaceBody),
    );

    expect(toast.success).toHaveBeenCalledWith("1 plugin imported");
    expect(toast.warning).toHaveBeenCalledWith(
      "2 plugin imports failed",
      expect.objectContaining({
        description: expect.stringContaining(
          "one: first reason · two: second reason",
        ),
      }),
    );
  });
});
