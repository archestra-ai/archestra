import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  createPlugin: vi.fn(),
  deletePlugin: vi.fn(),
  importGithubPlugin: vi.fn(),
  importGithubPluginMarketplace: vi.fn(),
}));

vi.mock("@archestra/shared/api-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@archestra/shared/api-sdk")>()),
  ...sdk,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  type CreatePluginBody,
  type ImportGithubPluginBody,
  type ImportGithubPluginMarketplaceBody,
  useBulkDeletePlugins,
  useCreatePlugin,
  useDeletePlugin,
  useImportGithubPlugin,
  useImportGithubPluginMarketplace,
} from "./plugin.query";

function createTestClient() {
  return new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
}

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: createTestClient() },
    children,
  );
}

describe("Plugin bulk mutations", () => {
  beforeEach(() => vi.clearAllMocks());

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

  it.each([
    {
      name: "create",
      run: async (client: QueryClient) => {
        sdk.createPlugin.mockResolvedValue({
          data: { id: "p-created" },
          error: undefined,
        });
        const { result } = renderHook(() => useCreatePlugin(), {
          wrapper: makeWrapper(client),
        });
        await act(() => result.current.mutateAsync({} as CreatePluginBody));
      },
    },
    {
      name: "import",
      run: async (client: QueryClient) => {
        sdk.importGithubPlugin.mockResolvedValue({
          data: { id: "p-imported" },
          error: undefined,
        });
        const { result } = renderHook(() => useImportGithubPlugin(), {
          wrapper: makeWrapper(client),
        });
        await act(() =>
          result.current.mutateAsync({} as ImportGithubPluginBody),
        );
      },
    },
    {
      name: "marketplace import",
      run: async (client: QueryClient) => {
        sdk.importGithubPluginMarketplace.mockResolvedValue({
          data: { created: [{ id: "p-mp" }], failed: [] },
          error: undefined,
        });
        const { result } = renderHook(
          () => useImportGithubPluginMarketplace(),
          {
            wrapper: makeWrapper(client),
          },
        );
        await act(() =>
          result.current.mutateAsync({} as ImportGithubPluginMarketplaceBody),
        );
      },
    },
    {
      name: "delete",
      run: async (client: QueryClient) => {
        sdk.deletePlugin.mockResolvedValue({
          data: { success: true },
          error: undefined,
        });
        const { result } = renderHook(() => useDeletePlugin("p-1"), {
          wrapper: makeWrapper(client),
        });
        await act(() => result.current.mutateAsync());
      },
    },
    {
      name: "bulk delete",
      run: async (client: QueryClient) => {
        sdk.deletePlugin.mockResolvedValue({
          data: { success: true },
          error: undefined,
        });
        const { result } = renderHook(() => useBulkDeletePlugins(), {
          wrapper: makeWrapper(client),
        });
        await act(() =>
          result.current.mutateAsync([{ id: "p-1", name: "One" }]),
        );
      },
    },
  ])("refetches scoped capabilities after a plugin $name", async ({ run }) => {
    const client = createTestClient();
    client.setQueryData(authQueryKeys.scopedCapabilities(), []);

    await run(client);

    expect(
      client.getQueryState(authQueryKeys.scopedCapabilities())?.isInvalidated,
    ).toBe(true);
  });
});
