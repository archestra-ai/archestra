import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInitiateOAuth } = vi.hoisted(() => ({
  mockInitiateOAuth: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      initiateOAuth: (...args: unknown[]) => mockInitiateOAuth(...args),
    },
  };
});

import { useInitiateOAuth } from "./oauth.query";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useInitiateOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects with the backend error message so callers can surface it", async () => {
    // The generated client returns the backend's `{ error: { message, type } }`
    // envelope; the hook must turn that into an Error whose message is the
    // backend reason, not the generic fallback.
    mockInitiateOAuth.mockResolvedValue({
      error: {
        error: {
          message: "No client ID available",
          type: "api_validation_error",
        },
      },
    });

    const { result } = renderHook(() => useInitiateOAuth(), { wrapper });

    await expect(
      result.current.mutateAsync({ catalogId: "catalog-1" }),
    ).rejects.toThrow("No client ID available");
  });

  it("returns the authorization URL on success", async () => {
    mockInitiateOAuth.mockResolvedValue({
      data: {
        authorizationUrl: "https://provider.example/authorize",
        state: "state-1",
      },
    });

    const { result } = renderHook(() => useInitiateOAuth(), { wrapper });

    await expect(
      result.current.mutateAsync({ catalogId: "catalog-1" }),
    ).resolves.toEqual({
      authorizationUrl: "https://provider.example/authorize",
      state: "state-1",
    });
  });
});
