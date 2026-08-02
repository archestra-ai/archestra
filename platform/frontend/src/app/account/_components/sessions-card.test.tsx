import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { SessionsCard } from "./sessions-card";

vi.mock("next/navigation");

vi.mock("@/lib/clients/auth/auth-client");

const CHROME_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const mockRouterPush = vi.fn();

function renderCard() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <SessionsCard />
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

describe("SessionsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: {
        user: { id: "user-1", email: "user@example.com" },
        session: { id: "session-current" },
      },
      error: null,
    } as Awaited<ReturnType<typeof authClient.getSession>>);
    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: [
        {
          id: "session-current",
          token: "token-current",
          userAgent: CHROME_MAC_UA,
          ipAddress: "10.0.0.1",
        },
        {
          id: "session-other",
          token: "token-other",
          userAgent: CHROME_MAC_UA,
          ipAddress: "10.0.0.2",
        },
      ],
      error: null,
    } as Awaited<ReturnType<typeof authClient.listSessions>>);
    vi.mocked(authClient.revokeSession).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.revokeSession>>);
  });

  it("shows loading skeletons while sessions are still being fetched", () => {
    vi.mocked(authClient.listSessions).mockReturnValue(
      new Promise(() => {}) as ReturnType<typeof authClient.listSessions>,
    );

    const { container } = renderCard();

    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("asks the user to sign in again when the session is too old to list sessions", async () => {
    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: null,
      error: { message: "Session is not fresh", code: "SESSION_NOT_FRESH" },
    } as Awaited<ReturnType<typeof authClient.listSessions>>);

    renderCard();

    expect(
      await screen.findByText(/sign in again to manage your sessions/i),
    ).toBeInTheDocument();
    // The failure must not be presented as "you have no other sessions".
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    // The panel tells the user to sign out, so it has to offer the way there.
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Sign Out" }));
    expect(mockRouterPush).toHaveBeenCalledWith("/auth/sign-out");
  });

  it("offers a retry when sessions fail to load for any other reason", async () => {
    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: null,
      error: { message: "Internal Server Error", status: 500 },
    } as Awaited<ReturnType<typeof authClient.listSessions>>);

    const user = userEvent.setup();
    renderCard();

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    // Retrying must re-hit the API, and a recovered request must render rows.
    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: [
        {
          id: "session-other",
          token: "token-other",
          userAgent: CHROME_MAC_UA,
          ipAddress: "10.0.0.2",
        },
      ],
      error: null,
    } as Awaited<ReturnType<typeof authClient.listSessions>>);

    await user.click(retry);

    expect(
      await screen.findByRole("button", { name: "Revoke" }),
    ).toBeInTheDocument();
  });

  it("keeps showing the list when a background refetch fails", async () => {
    const { queryClient } = renderCard();
    await screen.findByText("Current session");

    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: null,
      error: { message: "Session is not fresh", code: "SESSION_NOT_FRESH" },
    } as Awaited<ReturnType<typeof authClient.listSessions>>);
    await queryClient.refetchQueries({ queryKey: authQueryKeys.sessions() });

    await waitFor(() => {
      expect(authClient.listSessions).toHaveBeenCalledTimes(2);
    });
    // A refetch failure must not swap a working card for an error panel.
    expect(screen.getByText("Current session")).toBeInTheDocument();
    expect(
      screen.queryByText(/sign in again to manage your sessions/i),
    ).toBeNull();
  });

  it("removes a revoked session even if the follow-up refetch fails", async () => {
    const user = userEvent.setup();
    renderCard();
    const revoke = await screen.findByRole("button", { name: "Revoke" });

    // The invalidation refetch that follows the revoke fails.
    vi.mocked(authClient.listSessions).mockResolvedValue({
      data: null,
      error: { message: "Internal Server Error", status: 500 },
    } as Awaited<ReturnType<typeof authClient.listSessions>>);
    await user.click(revoke);

    // The revoked row must not survive as "signed in" after we said it was gone.
    await waitFor(() => {
      expect(screen.queryByText("10.0.0.2")).toBeNull();
    });
    expect(screen.getByText("Current session")).toBeInTheDocument();
  });

  it("labels the current session and describes devices from the user agent", async () => {
    renderCard();

    expect(await screen.findByText("Current session")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.2")).toBeInTheDocument();
    expect(screen.getAllByText(/Mac OS, Chrome/)).toHaveLength(2);
  });

  it("revokes another session by token", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(authClient.revokeSession).toHaveBeenCalledWith({
        token: "token-other",
      });
    });
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("signs out instead of revoking when targeting the current session", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Sign Out" }));

    expect(mockRouterPush).toHaveBeenCalledWith("/auth/sign-out");
    expect(authClient.revokeSession).not.toHaveBeenCalled();
  });
});
