import { render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArchestraQueryClientProvider } from "@/app/_parts/query-client-provider";
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession } from "@/mocks/data/auth";
import { ImpersonationBanner } from "./impersonation-banner";

vi.mock("@/lib/clients/auth/auth-client");
vi.mock("sonner");

const originalLocation = window.location;
const assign = vi.fn();
const HOUR = 60 * 60 * 1000;

/** An impersonated session that ends `left` milliseconds from now. */
function viewingAs(left: number) {
  const base = makeSession();
  return {
    ...base,
    user: { ...base.user, name: "Sam (Support)" },
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

function show() {
  render(
    <ArchestraQueryClientProvider>
      <ImpersonationBanner />
    </ArchestraQueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
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

test("says when viewing as another user ends, and returns to the admin's own session shortly before the impersonated one runs out", async () => {
  serverAnswersSession(viewingAs(HOUR));
  vi.mocked(authClient.$fetch).mockResolvedValue({
    data: {},
    error: null,
  } as never);
  show();
  expect(
    await screen.findByText(/^until \d{1,2}:\d{2}/, undefined, {
      timeout: 3000,
    }),
  ).toBeVisible();
  expect(screen.getByText("Sam (Support)")).toBeVisible();

  // Still an hour to go: nothing is ended early.
  await vi.advanceTimersByTimeAsync(57 * 60 * 1000);
  expect(authClient.$fetch).not.toHaveBeenCalled();

  // Two minutes before the end the app leaves, while it still can.
  await vi.advanceTimersByTimeAsync(60 * 1000 + 500);
  await waitFor(() =>
    expect(authClient.$fetch).toHaveBeenCalledWith(
      "/admin/stop-impersonating",
      // With a JSON body: a body-less POST from a page whose address has a
      // query string is refused (see useStopImpersonating).
      { method: "POST", body: {} },
    ),
  );
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  // The reload drops a toast, so the reason waits for the next page.
  expect(toast.success).not.toHaveBeenCalled();
});

test("the page that loads after such a return says why the admin is back in their own session, once", async () => {
  serverAnswersSession(viewingAs(3 * 60 * 1000));
  vi.mocked(authClient.$fetch).mockResolvedValue({
    data: {},
    error: null,
  } as never);
  show();
  await screen.findByText("Sam (Support)", undefined, { timeout: 3000 });
  await vi.advanceTimersByTimeAsync(61 * 1000);
  await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  expect(toast.info).not.toHaveBeenCalled();

  // The reloaded page, in the admin's own session.
  document.body.innerHTML = "";
  serverAnswersSession(makeSession());
  show();
  await waitFor(() =>
    expect(toast.info).toHaveBeenCalledWith(
      "Viewing as another user ended: it lasts one hour at most. You are back in your own session.",
      expect.anything(),
    ),
  );
  expect(toast.info).toHaveBeenCalledTimes(1);
});

test("a session that ran out before the app could return (a tab that slept) is checked again at once, and the reader is told why they are signed out", async () => {
  // Past its end already when the tab wakes.
  serverAnswersSession(viewingAs(-1000));
  vi.mocked(authClient.$fetch).mockResolvedValue({
    data: null,
    error: { status: 401, message: "Unauthorized" },
  } as never);
  show();
  await screen.findByText("Sam (Support)", undefined, { timeout: 3000 });
  // The server no longer knows the session.
  serverAnswersSession(null);
  await vi.advanceTimersByTimeAsync(100);
  await waitFor(() =>
    expect(screen.queryByText("Sam (Support)")).not.toBeInTheDocument(),
  );
  expect(toast.info).toHaveBeenCalledWith(
    "Viewing as another user ended: it lasts one hour at most. Sign in to continue.",
    expect.anything(),
  );
  // Not an error of the admin's making.
  expect(toast.error).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});
