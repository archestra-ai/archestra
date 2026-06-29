import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useChangeAccountPasswordMutation } from "./account.query";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    changePassword: vi.fn(),
  },
}));

describe("useChangeAccountPasswordMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a current-password-specific error for invalid current passwords", async () => {
    vi.mocked(authClient.changePassword).mockResolvedValue({
      data: null,
      error: { message: "Invalid password" },
    } as Awaited<ReturnType<typeof authClient.changePassword>>);

    const { result } = renderHook(() => useChangeAccountPasswordMutation(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.mutateAsync({
        currentPassword: "wrong-password",
        newPassword: "new-password",
      });
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Current password is invalid");
    });
  });
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}
