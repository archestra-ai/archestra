import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { useTwoFactorChallengePending } from "@/lib/auth/two-factor.query";
import {
  RequireEnrollableSession,
  RequirePendingTwoFactorChallenge,
} from "./auth-route-guard";

vi.mock("@/lib/auth/auth.query", () => ({ useSession: vi.fn() }));
vi.mock("@/lib/auth/two-factor.query", () => ({
  useTwoFactorChallengePending: vi.fn(),
}));

const replace = vi.fn();

function mockSession(data: unknown, isPending = false) {
  vi.mocked(useSession).mockReturnValue({
    data,
    isPending,
  } as unknown as ReturnType<typeof useSession>);
}

function mockChallenge(data: boolean | undefined, isPending = false) {
  vi.mocked(useTwoFactorChallengePending).mockReturnValue({
    data,
    isPending,
  } as unknown as ReturnType<typeof useTwoFactorChallengePending>);
}

describe("auth route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Swap only the navigation method: replacing the whole window object
    // breaks jsdom rendering, and the guard calls location.replace directly.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, replace },
    });
  });

  describe("RequireEnrollableSession", () => {
    it("renders enrollment for a signed-in, non-enrolled user", () => {
      mockSession({ user: { twoFactorEnabled: false } });

      render(
        <RequireEnrollableSession>
          <div>enrollment</div>
        </RequireEnrollableSession>,
      );

      expect(screen.getByText("enrollment")).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it("sends a signed-out visitor to sign-in", async () => {
      mockSession(null);

      render(
        <RequireEnrollableSession>
          <div>enrollment</div>
        </RequireEnrollableSession>,
      );

      expect(screen.queryByText("enrollment")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/auth/sign-in"),
      );
    });

    it("sends an already-enrolled user home", async () => {
      mockSession({ user: { twoFactorEnabled: true } });

      render(
        <RequireEnrollableSession>
          <div>enrollment</div>
        </RequireEnrollableSession>,
      );

      expect(screen.queryByText("enrollment")).not.toBeInTheDocument();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    });

    it("waits rather than redirecting while the session loads", () => {
      mockSession(undefined, true);

      render(
        <RequireEnrollableSession>
          <div>enrollment</div>
        </RequireEnrollableSession>,
      );

      expect(screen.queryByText("enrollment")).not.toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });
  });

  describe("RequirePendingTwoFactorChallenge", () => {
    it("renders the challenge when one is pending", () => {
      mockSession(null);
      mockChallenge(true);

      render(
        <RequirePendingTwoFactorChallenge>
          <div>challenge</div>
        </RequirePendingTwoFactorChallenge>,
      );

      expect(screen.getByText("challenge")).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it("sends a visitor with no pending challenge to sign-in", async () => {
      mockSession(null);
      mockChallenge(false);

      render(
        <RequirePendingTwoFactorChallenge>
          <div>challenge</div>
        </RequirePendingTwoFactorChallenge>,
      );

      expect(screen.queryByText("challenge")).not.toBeInTheDocument();
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/auth/sign-in"),
      );
    });

    it("sends an already signed-in user home", async () => {
      mockSession({ user: { twoFactorEnabled: true } });
      mockChallenge(false);

      render(
        <RequirePendingTwoFactorChallenge>
          <div>challenge</div>
        </RequirePendingTwoFactorChallenge>,
      );

      expect(screen.queryByText("challenge")).not.toBeInTheDocument();
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    });

    it("waits rather than redirecting while the challenge check loads", () => {
      mockSession(null);
      mockChallenge(undefined, true);

      render(
        <RequirePendingTwoFactorChallenge>
          <div>challenge</div>
        </RequirePendingTwoFactorChallenge>,
      );

      expect(screen.queryByText("challenge")).not.toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });
  });
});
