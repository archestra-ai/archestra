import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateChatOpsConfigInQuickstart } from "./chatops-config.query";
import { handleApiError } from "./utils";

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      updateChatOpsConfigInQuickstart: vi.fn(),
    },
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./utils", async () => {
  const actual = await vi.importActual("./utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useUpdateChatOpsConfigInQuickstart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns data on success", async () => {
    vi.mocked(
      archestraApiSdk.updateChatOpsConfigInQuickstart,
    ).mockResolvedValue({
      data: { success: true },
    } as Awaited<
      ReturnType<typeof archestraApiSdk.updateChatOpsConfigInQuickstart>
    >);

    const { result } = renderHook(() => useUpdateChatOpsConfigInQuickstart(), {
      wrapper: createWrapper(),
    });

    const mutationResult = await result.current.mutateAsync({
      enabled: true,
      appId: "test-app-id",
      appSecret: "test-secret",
      tenantId: "test-tenant",
    });

    expect(mutationResult).toEqual({ success: true });
    expect(handleApiError).not.toHaveBeenCalled();
  });

  it("returns null and handles API errors", async () => {
    const apiError = {
      error: {
        message: "Only available in quickstart mode",
        type: "api_authorization_error" as const,
      },
    };

    vi.mocked(
      archestraApiSdk.updateChatOpsConfigInQuickstart,
    ).mockResolvedValue({
      data: undefined,
      error: apiError,
    } as Awaited<
      ReturnType<typeof archestraApiSdk.updateChatOpsConfigInQuickstart>
    >);

    const { result } = renderHook(() => useUpdateChatOpsConfigInQuickstart(), {
      wrapper: createWrapper(),
    });

    const mutationResult = await result.current.mutateAsync({
      enabled: true,
      appId: "test-app-id",
      appSecret: "test-secret",
      tenantId: "test-tenant",
    });

    expect(mutationResult).toBeNull();
    expect(handleApiError).toHaveBeenCalledWith(apiError);
  });
});
