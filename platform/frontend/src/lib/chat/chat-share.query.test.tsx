import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import {
  useConversationShare,
  useForkConversation,
  useForkSharedConversation,
} from "./chat-share.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    getConversationShare: vi.fn(),
    shareConversation: vi.fn(),
    unshareConversation: vi.fn(),
    forkChatConversation: vi.fn(),
    forkSharedConversation: vi.fn(),
  },
}));

vi.mock("@/lib/utils", async () => {
  const actual = await vi.importActual("@/lib/utils");
  return {
    ...actual,
    handleApiError: vi.fn(),
  };
});

const mockedHandleApiError = vi.mocked(handleApiError);

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

type ErrorResult = {
  data: undefined;
  error: unknown;
  response?: { status: number };
};
const errorResult = (status: number): ErrorResult => ({
  data: undefined,
  error: { message: "boom" },
  response: { status },
});

describe("useConversationShare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays silent and returns null on a 404 (chat not shared)", async () => {
    vi.mocked(archestraApiSdk.getConversationShare).mockResolvedValue(
      errorResult(404) as Awaited<
        ReturnType<typeof archestraApiSdk.getConversationShare>
      >,
    );

    const { result } = renderHook(() => useConversationShare("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("toasts and returns null on a non-404 error", async () => {
    vi.mocked(archestraApiSdk.getConversationShare).mockResolvedValue(
      errorResult(500) as Awaited<
        ReturnType<typeof archestraApiSdk.getConversationShare>
      >,
    );

    const { result } = renderHook(() => useConversationShare("c1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.data).toBeNull());
    expect(mockedHandleApiError).toHaveBeenCalledTimes(1);
  });
});

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

  it("useForkSharedConversation leaves project queries untouched for a non-project fork", async () => {
    vi.mocked(archestraApiSdk.forkSharedConversation).mockResolvedValue({
      data: { id: "forked", projectId: null },
      error: undefined,
    } as Awaited<ReturnType<typeof archestraApiSdk.forkSharedConversation>>);

    const { invalidateSpy, result } = renderWithClient(() =>
      useForkSharedConversation(),
    );

    await result.current.mutateAsync({ shareId: "s1", agentId: "a1" });

    const touchedProjects = invalidateSpy.mock.calls.some(
      ([arg]) => Array.isArray(arg?.queryKey) && arg.queryKey[0] === "projects",
    );
    expect(touchedProjects).toBe(false);
  });
});
