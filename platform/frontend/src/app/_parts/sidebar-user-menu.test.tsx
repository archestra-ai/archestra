import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { SidebarUserMenu } from "./sidebar-user-menu";

vi.mock("@/lib/clients/auth/auth-client");

const { mockUseTheme } = vi.hoisted(() => ({
  mockUseTheme: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => mockUseTheme(),
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

function mockSignedInSession() {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" },
      session: { id: "session-1" },
    },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
}

describe("SidebarUserMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseTheme.mockReturnValue({ theme: "system", setTheme: vi.fn() });
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

  it("shows the user and exposes personal links and Sign Out", async () => {
    const user = userEvent.setup();
    mockSignedInSession();

    renderMenu();

    const trigger = await screen.findByRole("button", {
      name: /Ada Lovelace/,
    });
    expect(trigger).toHaveTextContent("ada@example.com");
    // Initials avatar fallback
    expect(trigger).toHaveTextContent("AD");

    await user.click(trigger);

    expect(
      await screen.findByRole("menuitem", { name: /personal settings/i }),
    ).toHaveAttribute("href", "/account");
    expect(screen.getByRole("menuitem", { name: /my usage/i })).toHaveAttribute(
      "href",
      "/llm/usage",
    );
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toHaveAttribute(
      "href",
      "/auth/sign-out",
    );
  });

  it("orders My Usage between Personal Settings and Sign Out", async () => {
    const user = userEvent.setup();
    mockSignedInSession();

    renderMenu();

    await user.click(
      await screen.findByRole("button", { name: /Ada Lovelace/ }),
    );

    const themeSwitcher = (
      await screen.findByRole("button", { name: "System" })
    ).parentElement as HTMLElement;
    const settings = screen.getByRole("menuitem", {
      name: /personal settings/i,
    });
    const usage = screen.getByRole("menuitem", { name: /my usage/i });
    const signOut = screen.getByRole("menuitem", { name: /sign out/i });

    expect(
      themeSwitcher.compareDocumentPosition(settings) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      settings.compareDocumentPosition(usage) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      usage.compareDocumentPosition(signOut) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("switches the theme via the theme mode buttons", async () => {
    const user = userEvent.setup();
    const setTheme = vi.fn();
    mockUseTheme.mockReturnValue({ theme: "system", setTheme });
    mockSignedInSession();

    renderMenu();

    await user.click(
      await screen.findByRole("button", { name: /Ada Lovelace/ }),
    );

    const darkButton = await screen.findByRole("button", { name: "Dark" });
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(darkButton).toHaveAttribute("aria-pressed", "false");

    await user.click(darkButton);
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});
