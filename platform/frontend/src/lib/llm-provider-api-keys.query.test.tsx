import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetLlmProviderApiKeys, mockToastError } = vi.hoisted(() => ({
  mockGetLlmProviderApiKeys: vi.fn(),
  mockToastError: vi.fn(),
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

import { useLlmProviderApiKeys } from "./llm-provider-api-keys.query";

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
