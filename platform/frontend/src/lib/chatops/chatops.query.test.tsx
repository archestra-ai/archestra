import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import { useApplyChatOpsBindingPlan } from "./chatops.query";

vi.mock("sonner");
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      applyChatOpsBindingPlan: vi.fn(),
    },
  };
});
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, handleApiError: vi.fn() };
});

describe("useApplyChatOpsBindingPlan", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects failed saves so the parent form can keep its staged changes", async () => {
    const apiError = {
      error: {
        message: "Channel assignments changed",
        type: "api_conflict_error",
      },
    };
    vi.mocked(archestraApiSdk.applyChatOpsBindingPlan).mockResolvedValue({
      error: apiError,
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useApplyChatOpsBindingPlan(), {
      wrapper,
    });

    await expect(
      result.current.mutateAsync({
        targetAgentId: "00000000-0000-4000-8000-000000000001",
        updates: [],
        directMessages: [{ provider: "slack" }],
      }),
    ).rejects.toThrow("Channel assignments changed");
    expect(handleApiError).toHaveBeenCalledWith(apiError);
  });
});
