import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConnectedClientsMock, getConnectedUsersMock } = vi.hoisted(() => ({
  getConnectedClientsMock: vi.fn(),
  getConnectedUsersMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getConnectedClients: getConnectedClientsMock,
      getConnectedUsers: getConnectedUsersMock,
    },
  };
});

import {
  useConnectedClients,
  useConnectedUsers,
} from "./connected-client.query";

function createWrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("connected client queries", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("lists the caller's connected clients", async () => {
    const rows = [{ clientId: "claude-code", platform: "macos" }];
    getConnectedClientsMock.mockResolvedValue({ data: rows, error: null });

    const { result } = renderHook(() => useConnectedClients(), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.data).toEqual(rows));
  });

  it("pages through connected members", async () => {
    const page = { data: [], pagination: { total: 0 } };
    getConnectedUsersMock.mockResolvedValue({ data: page, error: null });

    const { result } = renderHook(
      () => useConnectedUsers({ limit: 20, offset: 40 }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.data).toEqual(page));
    expect(getConnectedUsersMock).toHaveBeenCalledWith({
      query: { limit: 20, offset: 40 },
    });
  });
});
