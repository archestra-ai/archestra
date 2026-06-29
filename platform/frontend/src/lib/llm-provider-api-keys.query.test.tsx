import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetLlmProviderApiKeys, mockToastError, mockHasPermissions } =
  vi.hoisted(() => ({
    mockGetLlmProviderApiKeys: vi.fn(),
    mockToastError: vi.fn(),
    mockHasPermissions: vi.fn(),
  }));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getLlmProviderApiKeys: (...args: unknown[]) =>
        mockGetLlmProviderApiKeys(...args),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => mockHasPermissions(),
}));

import {
  useHasAnyApiKey,
  useLlmProviderApiKeys,
} from "./llm-provider-api-keys.query";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useLlmProviderApiKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enters the error state when the request fails (instead of returning [])", async () => {
    mockGetLlmProviderApiKeys.mockResolvedValue({
      error: new Error("Network request failed"),
    });

    const { result } = renderHook(() => useLlmProviderApiKeys({}), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    // First-fetch failure with no cached data — the signal the gating screens
    // branch on to show the load-error state.
    expect(result.current.isLoadingError).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("does not toast on failure when toastOnError is false", async () => {
    mockGetLlmProviderApiKeys.mockResolvedValue({
      error: new Error("Network request failed"),
    });

    const { result } = renderHook(
      () => useLlmProviderApiKeys({ toastOnError: false }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("returns the keys on success without an error", async () => {
    mockGetLlmProviderApiKeys.mockResolvedValue({ data: [] });

    const { result } = renderHook(() => useLlmProviderApiKeys({}), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toEqual([]);
  });
});

describe("useHasAnyApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasPermissions.mockReturnValue({ data: true });
  });

  it("reports a load error when the first keys fetch fails", async () => {
    mockGetLlmProviderApiKeys.mockResolvedValue({
      error: new Error("Network request failed"),
    });

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.isLoadError).toBe(true));
    expect(result.current.hasAnyApiKey).toBe(false);
  });

  it("does not run the query or report a load error without read permission", async () => {
    mockHasPermissions.mockReturnValue({ data: false });

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isLoadError).toBe(false);
    expect(mockGetLlmProviderApiKeys).not.toHaveBeenCalled();
  });

  it("reports a configured key when the fetch succeeds with keys", async () => {
    mockGetLlmProviderApiKeys.mockResolvedValue({ data: [{ id: "key-1" }] });

    const { result } = renderHook(() => useHasAnyApiKey(), { wrapper });

    await waitFor(() => expect(result.current.hasAnyApiKey).toBe(true));
    expect(result.current.isLoadError).toBe(false);
  });
});
