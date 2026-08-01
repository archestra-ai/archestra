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

  it("enables 2FA, shows backup codes, then continues to authenticator setup", async () => {
    const user = userEvent.setup();
    mockSession(false);
    vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
      data: {
        totpURI: "otpauth://totp/Test?secret=ABC",
        backupCodes: ["code-one", "code-two"],
      },
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.enable>>);

    renderCard();

    await user.click(await screen.findByRole("button", { name: "Enable 2FA" }));
    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      // `issuer` is what the user's authenticator app shows beside the code, so
      // it must follow the deployment's brand rather than the built-in default.
      expect(authClient.twoFactor.enable).toHaveBeenCalledWith({
        password: "hunter22",
        issuer: "Acme AI",
      });
    });

    expect(await screen.findByText("Save Your Backup Codes")).toBeVisible();
    expect(screen.getByText("code-one")).toBeInTheDocument();
    expect(screen.getByText("code-two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mockRouterPush).toHaveBeenCalledWith(
      `/auth/two-factor?totpURI=${encodeURIComponent("otpauth://totp/Test?secret=ABC")}&redirectTo=${encodeURIComponent("/account")}`,
    );
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
      screen.getByRole("button", { name: "Enable 2FA" }),
    ).toBeInTheDocument();
  });

  it("does not show the mandate copy to already-enrolled users", async () => {
    mockSession(true);

    renderCard({ required: true });

    expect(
      await screen.findByRole("button", { name: "Disable 2FA" }),
    ).toBeInTheDocument();
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
      await screen.findByRole("button", { name: "Disable 2FA" }),
    ).toBeInTheDocument();
  });

  it("disables 2FA with password confirmation", async () => {
    const user = userEvent.setup();
    mockSession(true);
    vi.mocked(authClient.twoFactor.disable).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.disable>>);

    renderCard();

    await user.click(
      await screen.findByRole("button", { name: "Disable 2FA" }),
    );
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
