import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSignInWithEmailMutation } from "@/lib/auth/account.query";
import { authClient } from "@/lib/clients/auth/auth-client";

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    signIn: {
      email: vi.fn(),
    },
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

describe("useSignInWithEmailMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the redirect URL on a plain successful sign-in", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: { url: null },
      error: null,
    } as unknown as Awaited<ReturnType<typeof authClient.signIn.email>>);

    const { result } = renderHook(() => useSignInWithEmailMutation(), {
      wrapper: createWrapper(),
    });

    const outcome = await result.current.mutateAsync({
      email: "user@example.com",
      password: "hunter22",
      callbackURL: "/chat",
    });

    expect(outcome).toEqual({
      twoFactorRedirect: false,
      redirectUrl: "/chat",
    });
  });

  it("flags a two-factor redirect instead of treating the response as signed in", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: { twoFactorRedirect: true },
      error: null,
    } as unknown as Awaited<ReturnType<typeof authClient.signIn.email>>);

    const { result } = renderHook(() => useSignInWithEmailMutation(), {
      wrapper: createWrapper(),
    });

    const outcome = await result.current.mutateAsync({
      email: "user@example.com",
      password: "hunter22",
    });

    expect(outcome).toEqual({ twoFactorRedirect: true, redirectUrl: null });
  });

  it("returns null and does not redirect on error", async () => {
    vi.mocked(authClient.signIn.email).mockResolvedValue({
      data: null,
      error: { message: "Invalid email or password" },
    } as unknown as Awaited<ReturnType<typeof authClient.signIn.email>>);

    const { result } = renderHook(() => useSignInWithEmailMutation(), {
      wrapper: createWrapper(),
    });

    const outcome = await result.current.mutateAsync({
      email: "user@example.com",
      password: "wrong",
    });

    await waitFor(() => {
      expect(outcome).toBeNull();
    });
  });
});
