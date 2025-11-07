import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsAuthenticated } from "./auth.hook";
import { authClient } from "./clients/auth/auth-client";

// Mock the auth client
vi.mock("./clients/auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
  },
}));

describe("useIsAuthenticated", () => {
  it("should return true when user is authenticated", () => {
    // Mock session with user
    vi.mocked(authClient.useSession).mockReturnValue({
      data: {
        user: { id: "user123", email: "test@example.com" },
        session: { id: "session123" },
      },
    } as any);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(true);
  });

  it("should return false when user is not authenticated", () => {
    // Mock session without user
    vi.mocked(authClient.useSession).mockReturnValue({
      data: null,
    } as any);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });

  it("should return false when session data has no user", () => {
    // Mock session with null user
    vi.mocked(authClient.useSession).mockReturnValue({
      data: {
        user: null,
        session: { id: "session123" },
      },
    } as any);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });

  it("should return false when session data is undefined", () => {
    // Mock undefined session
    vi.mocked(authClient.useSession).mockReturnValue({
      data: undefined,
    } as any);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });
});
