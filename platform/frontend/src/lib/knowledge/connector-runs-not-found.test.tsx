import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetConnectorRuns, mockToastError } = vi.hoisted(() => ({
  mockGetConnectorRuns: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getConnectorRuns: (...args: unknown[]) => mockGetConnectorRuns(...args),
    },
  };
});

vi.mock("sonner", () => ({
  toast: { error: mockToastError, success: vi.fn() },
}));

import { useConnectorRuns } from "./connector.query";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useConnectorRuns — missing parent (404)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves to null (no error, no toast) when the connector is not found", async () => {
    mockGetConnectorRuns.mockResolvedValue({
      error: { type: "api_not_found_error" },
    });

    const { result } = renderHook(
      () => useConnectorRuns({ connectorId: "gone" }),
      { wrapper },
    );

    // A 404 must NOT enter the error state and must NOT trip react-query's own
    // "data is undefined" throw — it resolves successfully with a null result.
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("still surfaces a non-404 failure as an error", async () => {
    mockGetConnectorRuns.mockResolvedValue({
      error: { type: "api_internal_error", message: "boom" },
    });

    const { result } = renderHook(
      () => useConnectorRuns({ connectorId: "c1" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
