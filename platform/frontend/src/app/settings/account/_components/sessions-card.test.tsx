import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { SessionsCard } from "./sessions-card";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
  },
}));

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

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionsCard />
    </QueryClientProvider>,
  );
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
