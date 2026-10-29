import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ServerToolsUpdateError,
  useAgentDelegations,
  useUpdateAgentServerTools,
} from "@/lib/agent-tools.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    assignToolToAgent: vi.fn(),
    getAgentDelegations: vi.fn(),
    unassignToolFromAgent: vi.fn(),
  },
}));

vi.mock("sonner");

const sdk = vi.mocked(archestraApiSdk);

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

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

describe("useUpdateAgentServerTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.assignToolToAgent.mockResolvedValue({
      data: { success: true },
      error: undefined,
    } as never);
    sdk.unassignToolFromAgent.mockResolvedValue({
      data: { success: true },
      error: undefined,
    } as never);
  });

  it("resolves credentials at call time unless a shared connection is chosen", async () => {
    // A personal connection can only be used this way: the backend refuses
    // to pin one, which is what left the old one-click add doing nothing.
    const { result } = renderHook(() => useUpdateAgentServerTools(), {
      wrapper,
    });

    await act(() =>
      result.current.mutateAsync({
        agentId: "agent-1",
        add: ["tool-a"],
        remove: [],
        builtIn: false,
      }),
    );
    await act(() =>
      result.current.mutateAsync({
        agentId: "agent-1",
        add: ["tool-b"],
        remove: [],
        builtIn: false,
        credential: { mode: "static", mcpServerId: "org-connection" },
      }),
    );

    expect(sdk.assignToolToAgent).toHaveBeenNthCalledWith(1, {
      path: { agentId: "agent-1", toolId: "tool-a" },
      body: { resolveAtCallTime: true, credentialResolutionMode: "dynamic" },
    });
    expect(sdk.assignToolToAgent).toHaveBeenNthCalledWith(2, {
      path: { agentId: "agent-1", toolId: "tool-b" },
      body: {
        mcpServerId: "org-connection",
        resolveAtCallTime: false,
        credentialResolutionMode: "static",
      },
    });
  });

  it("reports how many tools still landed when some are refused", async () => {
    sdk.assignToolToAgent
      .mockResolvedValueOnce({
        data: { success: true },
        error: undefined,
      } as never)
      .mockResolvedValueOnce({
        data: undefined,
        error: {
          error: { message: "Not allowed", type: "api_validation_error" },
        },
      } as never);
    const { result } = renderHook(() => useUpdateAgentServerTools(), {
      wrapper,
    });

    const refusal = await result.current
      .mutateAsync({
        agentId: "agent-1",
        add: ["tool-a", "tool-b"],
        remove: [],
        builtIn: false,
      })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ServerToolsUpdateError);
    expect(refusal).toMatchObject({
      message: "Not allowed",
      addedCount: 1,
      requestedAddCount: 2,
    });
  });
});
