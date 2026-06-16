import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { SidebarUserMenu } from "./sidebar-user-menu";

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
  },
}));

function renderMenu() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarUserMenu />
    </QueryClientProvider>,
  );
}

describe("SidebarUserMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing without a session", async () => {
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: null,
      error: null,
    } as Awaited<ReturnType<typeof authClient.getSession>>);

    const { container } = renderMenu();

    // The session query resolves to null, so the menu stays empty
    await vi.waitFor(() => {
      expect(authClient.getSession).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the user and exposes Settings and Sign Out links", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.getSession).mockResolvedValue({
      data: {
        user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
        session: { id: "session-1" },
      },
      error: null,
    } as Awaited<ReturnType<typeof authClient.getSession>>);

    renderMenu();

    const trigger = await screen.findByRole("button", {
      name: /Ada Lovelace/,
    });
    expect(trigger).toHaveTextContent("ada@example.com");
    // Initials avatar fallback
    expect(trigger).toHaveTextContent("AD");

    await user.click(trigger);

    expect(
      await screen.findByRole("menuitem", { name: /settings/i }),
    ).toHaveAttribute("href", "/settings/account");
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toHaveAttribute(
      "href",
      "/auth/sign-out",
    );
  });
});
