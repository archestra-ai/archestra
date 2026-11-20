import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ArchestraQueryClientProvider } from "@/app/_parts/query-client-provider";
import { authClient } from "@/lib/clients/auth/auth-client";
import { makeSession } from "@/mocks/data/auth";
import { ImpersonationBanner } from "./impersonation-banner";

vi.mock("@/lib/clients/auth/auth-client");

beforeEach(() => {
  vi.clearAllMocks();
});

test("says who the admin is viewing as and until when", async () => {
  const base = makeSession();
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      ...base,
      user: { ...base.user, name: "Sam (Support)" },
      session: {
        ...base.session,
        impersonatedBy: "admin-1",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
  render(
    <ArchestraQueryClientProvider>
      <ImpersonationBanner />
    </ArchestraQueryClientProvider>,
  );
  expect(
    await screen.findByText(/^until \d{1,2}:\d{2}/, undefined, {
      timeout: 3000,
    }),
  ).toBeVisible();
  expect(screen.getByText("Sam (Support)")).toBeVisible();
});
