import { archestraApiSdk } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApiError } from "@/lib/utils";
import { useUpdateChatMessage } from "./chat-message.query";

vi.mock("@archestra/shared", () => ({
  archestraApiSdk: {
    updateChatMessage: vi.fn(),
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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

const updateArgs = {
  messageId: "m1",
  partIndex: 0,
  text: "edited",
};

describe("useUpdateChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns data and invalidates the conversation query on success", async () => {
    vi.mocked(archestraApiSdk.updateChatMessage).mockResolvedValue({
      data: { ok: true },
      error: undefined,
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.updateChatMessage>
    >);

    const { queryClient, wrapper } = createWrapper();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useUpdateChatMessage("c1"), {
      wrapper,
    });

    const value = await result.current.mutateAsync(updateArgs);

    expect(value).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["conversation", "c1"],
    });
    expect(mockedHandleApiError).not.toHaveBeenCalled();
  });

  it("returns null and toasts on error", async () => {
    vi.mocked(archestraApiSdk.updateChatMessage).mockResolvedValue({
      data: undefined,
      error: { message: "boom" },
      response: { status: 500 },
    } as unknown as Awaited<
      ReturnType<typeof archestraApiSdk.updateChatMessage>
    >);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUpdateChatMessage("c1"), {
      wrapper,
    });

    const value = await result.current.mutateAsync(updateArgs);

    expect(value).toBeNull();
    await waitFor(() => expect(mockedHandleApiError).toHaveBeenCalledTimes(1));
  });
});
