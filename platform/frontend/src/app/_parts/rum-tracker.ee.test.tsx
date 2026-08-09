import { render } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { usePublicConfig } from "@/lib/config/config.query";
import { rumClient } from "@/lib/rum.ee";
import { RumTracker } from "./rum-tracker.ee";

vi.mock("next/navigation");

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

// Spies (not a module mock) keep the singleton's real types; the no-op
// implementations keep the real client's timers and network flushes out of
// the test. The tracker renders null, so the spies are the only observable.
const startSpy = vi.spyOn(rumClient, "start").mockImplementation(() => {});
const stopSpy = vi.spyOn(rumClient, "stop").mockImplementation(() => {});
const setUserSpy = vi.spyOn(rumClient, "setUser").mockImplementation(() => {});
const trackPageViewSpy = vi
  .spyOn(rumClient, "trackPageView")
  .mockImplementation(() => {});

describe("RumTracker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/chat");
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({ enabled: true }),
    );
    vi.mocked(useSession).mockReturnValue(makeSessionResult("user-123"));
  });

  const makePublicConfigResult = ({
    enabled,
    sampleRate,
  }: {
    enabled: boolean;
    sampleRate?: number;
  }) =>
    ({
      data: { rum: { enabled, sampleRate } },
      isLoading: false,
    }) as unknown as ReturnType<typeof usePublicConfig>;

  const makeSessionResult = (userId: string | null) =>
    ({
      data: userId
        ? {
            user: {
              id: userId,
              email: "user@example.com",
              name: "Example User",
            },
            session: { id: "session-123" },
          }
        : null,
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: vi.fn(),
    }) as unknown as ReturnType<typeof useSession>;

  it("never starts the client when RUM is disabled in the public config", () => {
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({ enabled: false }),
    );

    render(<RumTracker />);

    expect(startSpy).not.toHaveBeenCalled();
    expect(setUserSpy).not.toHaveBeenCalled();
    expect(trackPageViewSpy).not.toHaveBeenCalled();
  });

  it("starts the client and reports the signed-in user once for a stable id", () => {
    const { rerender } = render(<RumTracker />);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(setUserSpy).toHaveBeenCalledTimes(1);
    expect(setUserSpy).toHaveBeenCalledWith("user-123");

    // A refetch of the same session must not re-report the user.
    rerender(<RumTracker />);

    expect(setUserSpy).toHaveBeenCalledTimes(1);
  });

  it("starts the client with the deployment's configured sample rate", () => {
    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({ enabled: true, sampleRate: 0.25 }),
    );

    render(<RumTracker />);

    expect(startSpy).toHaveBeenCalledWith({ sampleRate: 0.25 });
  });

  it("stops the client and never starts it while signed out", () => {
    vi.mocked(useSession).mockReturnValue(makeSessionResult(null));

    render(<RumTracker />);

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(setUserSpy).not.toHaveBeenCalled();
    expect(trackPageViewSpy).not.toHaveBeenCalled();
  });

  it("tracks one page view per navigation, in order", () => {
    const { rerender } = render(<RumTracker />);

    expect(trackPageViewSpy.mock.calls).toEqual([["/chat"]]);

    vi.mocked(usePathname).mockReturnValue("/tools");
    rerender(<RumTracker />);

    expect(trackPageViewSpy.mock.calls).toEqual([["/chat"], ["/tools"]]);
  });

  it("does not track /auth pages even while a session is present", () => {
    vi.mocked(usePathname).mockReturnValue("/auth/sign-in");

    render(<RumTracker />);

    // The client still runs — only the transient auth route is excluded.
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(trackPageViewSpy).not.toHaveBeenCalled();
  });

  it("stops the client on unmount", () => {
    const { unmount } = render(<RumTracker />);

    expect(stopSpy).not.toHaveBeenCalled();

    unmount();

    expect(stopSpy).toHaveBeenCalled();
  });

  it("stops the client when RUM is disabled across rerenders", () => {
    const { rerender } = render(<RumTracker />);

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();

    vi.mocked(usePublicConfig).mockReturnValue(
      makePublicConfigResult({ enabled: false }),
    );
    rerender(<RumTracker />);

    expect(stopSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });
});
