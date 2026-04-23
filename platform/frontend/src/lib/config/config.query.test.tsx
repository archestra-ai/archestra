import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFeature } from "./config.query";

vi.mock("@shared", async () => {
  const actual = await vi.importActual("@shared");
  return {
    ...actual,
    archestraApiSdk: {
      getConfig: vi.fn(),
      getPublicConfig: vi.fn(),
    },
  };
});

vi.mock("@/lib/auth/auth.hook", () => ({
  useIsAuthenticated: vi.fn(() => true),
}));

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

describe("config.query useFeature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined safely when optional memory flags are absent", async () => {
    vi.mocked(archestraApiSdk.getConfig).mockResolvedValue({
      data: {
        features: {
          ngrokDomain: null,
        },
        enterpriseFeatures: {},
      },
      error: undefined,
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getConfig>>);

    const { result } = renderHook(() => useFeature("memoryExtractionEnabled"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toBeUndefined();
    });
  });

  it("returns memory flag values when present", async () => {
    vi.mocked(archestraApiSdk.getConfig).mockResolvedValue({
      data: {
        features: {
          ngrokDomain: null,
          memoryExtractionEnabled: true,
          memoryInjectionEnabled: false,
          memoryExtractionAvailable: true,
        },
        enterpriseFeatures: {},
      },
      error: undefined,
    } as unknown as Awaited<ReturnType<typeof archestraApiSdk.getConfig>>);

    const extraction = renderHook(() => useFeature("memoryExtractionEnabled"), {
      wrapper: createWrapper(),
    });
    const injection = renderHook(() => useFeature("memoryInjectionEnabled"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(extraction.result.current).toBe(true);
      expect(injection.result.current).toBe(false);
    });
  });
});
