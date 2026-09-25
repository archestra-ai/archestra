import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useForkConversation } from "./chat-share.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    forkChatConversation: vi.fn(),
  },
}));

describe("fork project-list invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithClient = <T,>(hook: () => T) => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { invalidateSpy, ...renderHook(hook, { wrapper }) };
  };

  it("useForkConversation invalidates the project's conversation list when the fork lands in a project", async () => {
    vi.mocked(archestraApiSdk.forkChatConversation).mockResolvedValue({
      data: { id: "forked", projectId: "p1" },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.forkChatConversation>>);

    const { invalidateSpy, result } = renderWithClient(() =>
      useForkConversation(),
    );

    await result.current.mutateAsync({ conversationId: "c1", agentId: "a1" });

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["projects", "p1", "conversations"],
      }),
    );
  });

  it("useForkConversation leaves project queries untouched for a non-project fork", async () => {
    vi.mocked(archestraApiSdk.forkChatConversation).mockResolvedValue({
      data: { id: "forked", projectId: null },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.forkChatConversation>>);

    const { invalidateSpy, result } = renderWithClient(() =>
      useForkConversation(),
    );

    await result.current.mutateAsync({ conversationId: "c1", agentId: "a1" });

    const touchedProjects = invalidateSpy.mock.calls.some(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === "projects",
    );
    expect(touchedProjects).toBe(false);
  });
});
