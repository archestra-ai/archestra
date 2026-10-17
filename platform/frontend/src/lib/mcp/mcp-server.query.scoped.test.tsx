import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { getMcpServersMock } = vi.hoisted(() => ({
  getMcpServersMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getMcpServers: getMcpServersMock,
    },
  };
});

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => ({ data: true }),
  useSession: () => ({ data: { user: { id: "user-1" } } }),
}));

import { useMcpServersGroupedByCatalog } from "./mcp-server.query";

describe("installs of the catalogs on screen", () => {
  it("keep the installs already known while the catalogs on screen change", async () => {
    // One install per catalog asked for; the read that adds cat-b waits.
    let release: () => void = () => {};
    getMcpServersMock.mockImplementation(
      ({ query }: { query: { catalogIds: string[] } }) => {
        const answer = {
          data: query.catalogIds.map((catalogId) => ({
            id: `srv-${catalogId}`,
            catalogId,
            ownerId: "user-1",
          })),
        };
        if (!query.catalogIds.includes("cat-b")) return Promise.resolve(answer);
        return new Promise((resolve) => {
          release = () => resolve(answer);
        });
      },
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useMcpServersGroupedByCatalog({ catalogIdsIn: ids }),
      { wrapper, initialProps: { ids: ["cat-a"] } },
    );
    await waitFor(() => expect(result.current["cat-a"]).toHaveLength(1));

    // Typing in the search changes the catalogs on screen.
    rerender({ ids: ["cat-a", "cat-b"] });
    expect(result.current["cat-a"]).toHaveLength(1);

    release();
    await waitFor(() => expect(result.current["cat-b"]).toHaveLength(1));
    expect(result.current["cat-a"]).toHaveLength(1);
  });
});
