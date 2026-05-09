import { archestraApiSdk } from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import {
  useChangeAccountPasswordMutation,
  useSignInWithEmailMutation,
} from "./account.query";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    changePassword: vi.fn(),
    signIn: {
      email: vi.fn(),
    },
  },
}));

vi.mock("@shared", () => ({
  archestraApiSdk: {
    getDefaultCredentialsStatus: vi.fn(),
  },
  DEFAULT_ADMIN_EMAIL: "admin@example.com",
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

  it("checks backend default credential status after default admin email sign-in", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: { url: "/chat" },
      error: null,
    } as Awaited<ReturnType<typeof authClient.signIn.email>>);
    vi.mocked(archestraApiSdk.getDefaultCredentialsStatus).mockResolvedValue({
      data: { enabled: true },
      error: undefined,
      response: new Response(),
      request: new Request("http://localhost"),
    } as Awaited<
      ReturnType<typeof archestraApiSdk.getDefaultCredentialsStatus>
    >);

    const { result } = renderHook(() => useSignInWithEmailMutation(), {
      wrapper: createWrapper(),
    });

    await expect(
      result.current.mutateAsync({
        email: "admin@example.com",
        password: "password",
        callbackURL: "/chat",
      }),
    ).resolves.toEqual({
      requiresDefaultPasswordChange: true,
      redirectUrl: "/chat",
    });
    expect(archestraApiSdk.getDefaultCredentialsStatus).toHaveBeenCalled();
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
