import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArchestraQueryClientProvider } from "@/app/_parts/query-client-provider";
import { Toaster } from "@/components/ui/sonner";
import { authClient } from "@/lib/clients/auth/auth-client";
import { impersonationEndedNotice } from "@/lib/impersonation-ended-notice";
import { makeSession } from "@/mocks/data/auth";
import { ImpersonationExpiry } from "./impersonation-expiry";

vi.mock("@/lib/clients/auth/auth-client");

// The toaster asks for the colour scheme, which jsdom does not answer.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

const originalLocation = window.location;
const assign = vi.fn();
const MINUTE = 60 * 1000;
const RETURNED =
  "Viewing as another user ended: it lasts one hour at most. You are back in your own session.";
const SIGNED_OUT =
  "Viewing as another user ended: it lasts one hour at most. Sign in to continue.";

/** An impersonated session that ends `left` milliseconds from now. */
function viewingAs(left: number) {
  const base = makeSession();
  return {
    ...base,
    session: {
      ...base.session,
      impersonatedBy: "admin-1",
      expiresAt: new Date(Date.now() + left).toISOString(),
    },
  };
}

function serverAnswersSession(session: unknown) {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: session,
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
}

function returnAnswers(...answers: Array<"ok" | { status: number }>) {
  const fetch = vi.mocked(authClient.$fetch);
  for (const answer of answers)
    fetch.mockResolvedValueOnce(
      (answer === "ok"
        ? { data: {}, error: null }
        : {
            data: null,
            error: { status: answer.status, message: "Refused" },
          }) as never,
    );
}

// A page without the banner, as an app's own page or a browser preview is.
// The real toaster, not a mock: the notice once fired before the toaster
// listened, and a mocked `toast` still counted that as shown.
function showPage() {
  return render(
    <ArchestraQueryClientProvider>
      <Toaster />
      <ImpersonationExpiry />
    </ArchestraQueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  serverAnswersSession(null);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
});

test("returns to the admin's own session shortly before the impersonated one runs out, on a page that has no banner", async () => {
  serverAnswersSession(viewingAs(60 * MINUTE));
  returnAnswers("ok");
  showPage();
  await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());

  // Still an hour to go: nothing is ended early.
  await vi.advanceTimersByTimeAsync(57 * MINUTE);
  expect(authClient.$fetch).not.toHaveBeenCalled();

  // Two minutes before the end the app leaves, while it still can.
  await vi.advanceTimersByTimeAsync(MINUTE + 500);
  await waitFor(() =>
    expect(authClient.$fetch).toHaveBeenCalledWith(
      "/admin/stop-impersonating",
      { method: "POST", body: {} },
    ),
  );
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  // The reload drops a toast, so the reason waits for the next page.
  expect(screen.queryByText("Returned to admin session")).toBeNull();
  expect(impersonationEndedNotice.take()).toBe("returned");
});

test("a return that fails while the session is still valid is tried again", async () => {
  serverAnswersSession(viewingAs(3 * MINUTE));
  // A server fault first; the session is as it was.
  returnAnswers({ status: 500 }, "ok");
  showPage();
  await waitFor(() => expect(authClient.getSession).toHaveBeenCalled());

  await vi.advanceTimersByTimeAsync(MINUTE + 500);
  await waitFor(() => expect(authClient.$fetch).toHaveBeenCalledTimes(1));
  expect(assign).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(16 * 1000);
  await waitFor(() => expect(authClient.$fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  expect(impersonationEndedNotice.take()).toBe("returned");
});

test("a session that ran out before the app could return (a tab that slept) is checked again at once, and the reason is kept for the sign-in page", async () => {
  // Past its end already when the tab wakes.
  serverAnswersSession(viewingAs(-1000));
  returnAnswers({ status: 401 });
  showPage();
  await waitFor(() => expect(authClient.getSession).toHaveBeenCalledTimes(1));
  // The server no longer knows the session.
  serverAnswersSession(null);
  await vi.advanceTimersByTimeAsync(100);
  await waitFor(() => expect(authClient.getSession).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(sessionStorage.getItem("archestra:impersonation-ended")).toBe(
      "signed-out",
    ),
  );
  expect(assign).not.toHaveBeenCalled();
  // Nothing left to return from: no second attempt.
  await vi.advanceTimersByTimeAsync(60 * 1000);
  expect(authClient.$fetch).toHaveBeenCalledTimes(1);
  // Not an error of the admin's making.
  expect(screen.queryByText("Failed to return to admin session")).toBeNull();
});

test("the page that loads after the app returned to the admin's session says why, once", async () => {
  impersonationEndedNotice.remember("returned");
  const first = showPage();
  expect(await screen.findByText(RETURNED)).toBeVisible();

  first.unmount();
  expect(impersonationEndedNotice.take()).toBeNull();
});

test("the sign-in page that follows a session that ran out says why", async () => {
  impersonationEndedNotice.remember("signed-out");
  showPage();
  expect(await screen.findByText(SIGNED_OUT)).toBeVisible();
});

test("says nothing on a page that follows no such end", async () => {
  showPage();
  await vi.advanceTimersByTimeAsync(50);
  expect(screen.queryByText(/Viewing as another user ended/)).toBeNull();
});
