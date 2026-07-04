import { FEEDBACK_TYPEFORM_URL } from "@archestra/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix dialog needs these in jsdom
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@/lib/auth/auth.query");
vi.mock("@/lib/hooks/use-app-name");

const markItemsSeen = vi.fn();
const mockState: {
  seen: string[];
  seenLoaded: boolean;
  activatedAt: string | null;
} = { seen: [], seenLoaded: true, activatedAt: null };

vi.mock("@/lib/onboarding/onboarding.query", () => ({
  useSeenNavItems: () => ({
    data: { items: mockState.seen },
    isSuccess: mockState.seenLoaded,
  }),
  useMarkNavItemsSeen: () => ({ mutate: markItemsSeen }),
  useFeedbackPopupActivation: ({ enabled }: { enabled: boolean }) => ({
    data: enabled ? { activatedAt: mockState.activatedAt } : undefined,
  }),
}));

const capture = vi.fn();
vi.mock("posthog-js", () => ({
  default: { capture: (...args: unknown[]) => capture(...args) },
}));

import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { FeedbackPopupDialog } from "./feedback-popup-dialog";

const SESSION_STARTED_AT = "2026-07-03T10:00:00.000Z";
const BEFORE_SESSION = "2026-07-03T09:00:00.000Z";
const AFTER_SESSION = "2026-07-03T11:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mockState.seen = [];
  mockState.seenLoaded = true;
  mockState.activatedAt = BEFORE_SESSION;
  vi.mocked(useAppName).mockReturnValue("Archestra");
  vi.mocked(useHasPermissions).mockReturnValue({ data: true } as ReturnType<
    typeof useHasPermissions
  >);
  vi.mocked(useSession).mockReturnValue({
    data: { session: { createdAt: SESSION_STARTED_AT } },
  } as unknown as ReturnType<typeof useSession>);
});

describe("FeedbackPopupDialog", () => {
  it("shows for an admin whose session started after activation, and fires the PostHog event", () => {
    render(<FeedbackPopupDialog />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(capture).toHaveBeenCalledWith("feedback_popup_viewed");
  });

  it("does not show for non-admins", () => {
    vi.mocked(useHasPermissions).mockReturnValue({ data: false } as ReturnType<
      typeof useHasPermissions
    >);
    render(<FeedbackPopupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not show before activation", () => {
    mockState.activatedAt = null;
    render(<FeedbackPopupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(capture).not.toHaveBeenCalled();
  });

  it("does not show in the session where activation happened (only the next one)", () => {
    mockState.activatedAt = AFTER_SESSION;
    render(<FeedbackPopupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not show again once dismissed previously", () => {
    mockState.seen = ["feedback:popup"];
    render(<FeedbackPopupDialog />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("'Not now' closes and records the dismissal", async () => {
    const user = userEvent.setup();
    render(<FeedbackPopupDialog />);

    await user.click(screen.getByRole("button", { name: "Not now" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markItemsSeen).toHaveBeenCalledWith(["feedback:popup"]);
  });

  it("'Share feedback' opens the Typeform in a new tab, closes, and records", async () => {
    const openSpy = vi
      .spyOn(window, "open")
      .mockReturnValue(null as unknown as Window);
    const user = userEvent.setup();
    render(<FeedbackPopupDialog />);

    await user.click(screen.getByRole("button", { name: "Share feedback" }));

    expect(openSpy).toHaveBeenCalledWith(
      FEEDBACK_TYPEFORM_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markItemsSeen).toHaveBeenCalledWith(["feedback:popup"]);
  });

  it("closing via Escape also records the dismissal", async () => {
    const user = userEvent.setup();
    render(<FeedbackPopupDialog />);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(markItemsSeen).toHaveBeenCalledWith(["feedback:popup"]);
  });
});
