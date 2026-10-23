import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAgentCatalog,
  useAllMatchingAgentCatalog,
} from "./agent-catalog.query";

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getAgentCatalog: vi.fn(),
    },
  };
});

const sdk = vi.mocked(archestraApiSdk);

function setup<T>(hook: () => T) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

describe("useAllMatchingAgentCatalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("walks catalog pages without splitting regular and external agents", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      type: "agent" as const,
      value: { id: `regular-${index}` },
    }));
    const finalRow = {
      type: "external" as const,
      value: { id: "external-100" },
    };
    sdk.getAgentCatalog
      .mockResolvedValueOnce({
        data: { data: firstPage },
        error: undefined,
      } as never)
      .mockResolvedValueOnce({
        data: { data: [finalRow] },
        error: undefined,
      } as never);

    const { result } = setup(() =>
      useAllMatchingAgentCatalog({
        name: "research",
        sortBy: "name",
        sortDirection: "asc",
      }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(101);
    expect(result.current.data?.at(-1)).toEqual(finalRow);
    expect(sdk.getAgentCatalog).toHaveBeenNthCalledWith(1, {
      query: {
        name: "research",
        sortBy: "name",
        sortDirection: "asc",
        includeTools: false,
        selectableOnly: true,
        limit: 100,
        offset: 0,
      },
    });
    expect(sdk.getAgentCatalog).toHaveBeenNthCalledWith(2, {
      query: {
        name: "research",
        sortBy: "name",
        sortDirection: "asc",
        includeTools: false,
        selectableOnly: true,
        limit: 100,
        offset: 100,
      },
    });
  });
});

describe("useAgentCatalog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for rows without their tools unless the caller wants them", async () => {
    sdk.getAgentCatalog.mockResolvedValue({
      data: { data: [] },
      error: undefined,
    } as never);

    const { result } = setup(() => ({
      page: useAgentCatalog({ limit: 10, offset: 0 }),
      withTools: useAgentCatalog({ limit: 10, offset: 0, includeTools: true }),
    }));

    await waitFor(() => {
      expect(result.current.page.isSuccess).toBe(true);
      expect(result.current.withTools.isSuccess).toBe(true);
    });
    expect(sdk.getAgentCatalog).toHaveBeenCalledWith({
      query: { includeTools: false, limit: 10, offset: 0 },
    });
    expect(sdk.getAgentCatalog).toHaveBeenCalledWith({
      query: { includeTools: true, limit: 10, offset: 0 },
    });
  });
});
