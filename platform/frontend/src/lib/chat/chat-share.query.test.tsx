import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import { useConversationShare } from "./chat-share.query";

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
