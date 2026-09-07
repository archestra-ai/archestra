import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationKeys } from "./organization.query";

const {
  createConnectionPassthroughKeyMock,
  createConnectionSetupMock,
  createConnectionVirtualKeyMock,
  handleApiErrorMock,
} = vi.hoisted(() => ({
  createConnectionPassthroughKeyMock: vi.fn(),
  createConnectionSetupMock: vi.fn(),
  createConnectionVirtualKeyMock: vi.fn(),
  handleApiErrorMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      createConnectionPassthroughKey: createConnectionPassthroughKeyMock,
      createConnectionSetup: createConnectionSetupMock,
      createConnectionVirtualKey: createConnectionVirtualKeyMock,
    },
  };
});

vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, handleApiError: handleApiErrorMock };
});

import {
  useCreateConnectionPassthroughKey,
  useCreateConnectionSetup,
  useCreateConnectionVirtualKey,
} from "./connection-setup.query";

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

type ConnectionMutation = {
  mutateAsync: (body: unknown) => Promise<unknown>;
};

const mutationCases = [
  {
    name: "setup command",
    sdkMock: createConnectionSetupMock,
    useMutation: useCreateConnectionSetup,
    body: {
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      provider: "anthropic",
    },
  },
  {
    name: "virtual key",
    sdkMock: createConnectionVirtualKeyMock,
    useMutation: useCreateConnectionVirtualKey,
    body: { provider: "anthropic" },
  },
  {
    name: "passthrough key",
    sdkMock: createConnectionPassthroughKeyMock,
    useMutation: useCreateConnectionPassthroughKey,
    body: { llmProxyId: "proxy-1" },
  },
] as const;

function renderMutation(useMutation: () => unknown, queryClient: QueryClient) {
  return renderHook(() => useMutation() as ConnectionMutation, {
    wrapper: createWrapper(queryClient),
  });
}

function apiError(message: string, type: string, statusCode: number) {
  return { data: undefined, error: { error: { message, type, statusCode } } };
}

describe("connection setup mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(
    mutationCases,
  )("refreshes active organization settings after a disabled Connect feature denial for $name", async ({
    sdkMock,
    useMutation,
    body,
  }) => {
    sdkMock.mockResolvedValue(
      apiError(
        "Connecting the LLM Proxy is disabled for this organization",
        "api_authorization_error",
        403,
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderMutation(useMutation, queryClient);

    await expect(result.current.mutateAsync(body)).resolves.toBeNull();

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: organizationKeys.details(),
      refetchType: "active",
    });
    expect(handleApiErrorMock).toHaveBeenCalledTimes(1);
  });

  it.each(
    mutationCases,
  )("does not refresh organization settings for an unrelated $name failure", async ({
    sdkMock,
    useMutation,
    body,
  }) => {
    sdkMock.mockResolvedValue(
      apiError("Provider key is unavailable", "api_validation_error", 400),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderMutation(useMutation, queryClient);

    await expect(result.current.mutateAsync(body)).resolves.toBeNull();

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(handleApiErrorMock).toHaveBeenCalledTimes(1);
  });
});
