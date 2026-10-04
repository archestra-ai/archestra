import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useEnterpriseFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { TwoFactorCard } from "./two-factor-card";

vi.mock("next/navigation");

vi.mock("@/lib/clients/auth/auth-client");

// Pinned to a non-default brand so the enrollment assertion below proves the
// issuer follows the deployment's name rather than coincidentally matching it.
vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/config/config.query");

const mockRouterPush = vi.fn();

function renderCard({ required = false } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TwoFactorCard required={required} />
    </QueryClientProvider>,
  );
}

function mockSession(twoFactorEnabled: boolean) {
  vi.mocked(authClient.getSession).mockResolvedValue({
    data: {
      user: { id: "user-1", email: "user@example.com", twoFactorEnabled },
      session: { id: "session-1" },
    },
    error: null,
  } as Awaited<ReturnType<typeof authClient.getSession>>);
}

describe("TwoFactorCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    vi.mocked(useEnterpriseFeature).mockReturnValue(true);
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
  });

  it("runs enrollment in a dialog rather than navigating away", async () => {
    const user = userEvent.setup();
    mockSession(false);

    renderCard();

    const toggle = await screen.findByRole("switch", {
      name: "Two-factor authentication",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);
    expect(toggle).not.toBeChecked();

    // Same flow as mandatory enrollment, in place: the account page should
    // not hand the user off to /auth.
    expect(
      await screen.findByText("Set Up Two-Factor Authentication"),
    ).toBeVisible();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("explains the enrollment mandate when the organization requires 2FA", async () => {
    mockSession(false);

    renderCard({ required: true });

    expect(
      await screen.findByText(
        "Your organization requires two-factor authentication. Set it up now to continue using the platform.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Two-factor authentication" }),
    ).toBeInTheDocument();
  });

  it("does not show the mandate copy to already-enrolled users", async () => {
    mockSession(true);

    renderCard({ required: true });

    const toggle = await screen.findByRole("switch", {
      name: "Two-factor authentication",
    });
    await waitFor(() => expect(toggle).toBeChecked());
    expect(
      screen.queryByText(
        "Your organization requires two-factor authentication. Set it up now to continue using the platform.",
      ),
    ).not.toBeInTheDocument();
  });

  it("hides entirely for non-enrolled users without an enterprise license", async () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    mockSession(false);

    const { container } = renderCard();

    expect(container).toBeEmptyDOMElement();
  });

  it("stays visible for enrolled users when the license lapses, so 2FA can be disabled", async () => {
    vi.mocked(useEnterpriseFeature).mockReturnValue(false);
    mockSession(true);

    renderCard();

    expect(
      await screen.findByRole("switch", { name: "Two-factor authentication" }),
    ).toBeInTheDocument();
  });

  it.each([
    false,
    true,
  ])("keeps 2FA unchanged when its dialog is cancelled (enabled: %s)", async (enabled) => {
    const user = userEvent.setup();
    mockSession(enabled);
    renderCard();
    const toggle = await screen.findByRole("switch", {
      name: "Two-factor authentication",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    await user.click(toggle);
    expect(await screen.findByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAttribute("aria-checked", String(enabled));
    expect(authClient.twoFactor.enable).not.toHaveBeenCalled();
    expect(authClient.twoFactor.disable).not.toHaveBeenCalled();
  });

  it("disables 2FA with password confirmation", async () => {
    const user = userEvent.setup();
    mockSession(true);
    vi.mocked(authClient.twoFactor.disable).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.disable>>);

    renderCard();

    const toggle = await screen.findByRole("switch", {
      name: "Two-factor authentication",
    });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    expect(toggle).toBeChecked();
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      expect(authClient.twoFactor.disable).toHaveBeenCalledWith({
        password: "hunter22",
      });
    });
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
