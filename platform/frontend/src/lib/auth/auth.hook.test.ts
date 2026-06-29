import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useSession } from "@/lib/auth/auth.query";

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(),
}));

type Session = ReturnType<typeof useSession>;

describe("useIsAuthenticated", () => {
  it("should return true when user is authenticated", () => {
    // Mock session with user
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: { id: "user123", email: "test@example.com" },
        session: { id: "session123" },
      },
    } as Session);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(true);
  });

  it("should return false when user is not authenticated", () => {
    // Mock session without user
    vi.mocked(useSession).mockReturnValue({
      data: null,
    } as Session);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });

  it("should return false when session data has no user", () => {
    // Mock session with null user
    vi.mocked(useSession).mockReturnValue({
      data: {
        user: null,
        session: { id: "session123" },
      },
    } as unknown as Session);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });

  it("should return false when session data is undefined", () => {
    // Mock undefined session
    vi.mocked(useSession).mockReturnValue({
      data: undefined,
    } as unknown as Session);

    const { result } = renderHook(() => useIsAuthenticated());

    expect(result.current).toBe(false);
  });
});
