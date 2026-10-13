import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useAgentDelegations } from "@/lib/agent-tools.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: { getAgentDelegations: vi.fn() },
}));

const sdk = vi.mocked(archestraApiSdk);

describe("useAgentDelegations", () => {
  it("never reports the previous agent's subagents for the next agent", async () => {
    sdk.getAgentDelegations.mockImplementation((async ({
      path,
    }: {
      path: { agentId: string };
    }) =>
      path.agentId === "agent-a"
        ? { data: [{ id: "subagent-of-a" }], error: undefined }
        : // The second agent's read is still in flight.
          new Promise(() => {})) as never);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result, rerender } = renderHook(
      ({ agentId }) => useAgentDelegations(agentId),
      { wrapper, initialProps: { agentId: "agent-a" } },
    );
    await waitFor(() =>
      expect(result.current.data).toEqual([{ id: "subagent-of-a" }]),
    );

    rerender({ agentId: "agent-b" });

    // Shown on the chat picker as agent B's subagents, and seeded into the
    // agent form, where saving would copy them onto agent B.
    expect(result.current.data).toBeUndefined();
    expect(result.current.isSuccess).toBe(false);
  });
});
