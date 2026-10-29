import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useMcpServers } from "./mcp-server.query";

vi.mock("@/lib/auth/auth.query");
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: { ...actual.archestraApiSdk, getMcpServers: vi.fn() },
  };
});

it("keeps compact issue data separate from the full server roster", async () => {
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  const server = {
    id: "server-1",
    name: "Test server",
    assignedAgents: [{ id: "agent-1", name: "Test agent" }],
  };
  vi.mocked(archestraApiSdk.getMcpServers).mockImplementation((async (
    options,
  ) => ({
    data: [
      {
        ...server,
        assignedAgents:
          options?.query?.includeAssignedAgents === false
            ? []
            : server.assignedAgents,
      },
    ],
  })) as typeof archestraApiSdk.getMcpServers);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({
      compact: useMcpServers({ includeAssignedAgents: false }),
      unspecified: useMcpServers(),
      full: useMcpServers({ includeAssignedAgents: true }),
    }),
    { wrapper },
  );
  await waitFor(() => {
    expect(result.current.compact.isSuccess).toBe(true);
    expect(result.current.unspecified.isSuccess).toBe(true);
    expect(result.current.full.isSuccess).toBe(true);
  });
  expect(result.current.compact.data).toEqual([
    { ...server, assignedAgents: [] },
  ]);
  expect(result.current.full.data).toEqual([server]);
  // Agent usage is opt-in: a caller that does not ask shares the compact
  // request instead of making one of its own.
  expect(result.current.unspecified.data).toEqual(result.current.compact.data);
  expect(archestraApiSdk.getMcpServers).toHaveBeenCalledTimes(2);
});
