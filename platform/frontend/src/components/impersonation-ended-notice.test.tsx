import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { Toaster } from "@/components/ui/sonner";
import { impersonationEndedNotice } from "@/lib/impersonation-ended-notice";
import { ImpersonationEndedNotice } from "./impersonation-ended-notice";

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

// The real toaster, not a mock: the notice once fired before the toaster
// listened, and a mocked `toast` still counted that as shown.
function showPage() {
  return render(
    <>
      <Toaster />
      <ImpersonationEndedNotice />
    </>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

test("the page that loads after the app returned to the admin's session says why, once", async () => {
  impersonationEndedNotice.remember("returned");
  const first = showPage();
  expect(
    await screen.findByText(
      "Viewing as another user ended: it lasts one hour at most. You are back in your own session.",
    ),
  ).toBeVisible();

  first.unmount();
  expect(impersonationEndedNotice.take()).toBeNull();
});

test("the sign-in page that follows a session that ran out says why", async () => {
  impersonationEndedNotice.remember("signed-out");
  showPage();
  expect(
    await screen.findByText(
      "Viewing as another user ended: it lasts one hour at most. Sign in to continue.",
    ),
  ).toBeVisible();
});

test("says nothing on a page that follows no such end", async () => {
  showPage();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText(/Viewing as another user ended/)).toBeNull();
});
