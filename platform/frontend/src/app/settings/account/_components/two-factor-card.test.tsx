import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { TwoFactorCard } from "./two-factor-card";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    getSession: vi.fn(),
    twoFactor: {
      enable: vi.fn(),
      disable: vi.fn(),
    },
  },
}));

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
      <TwoFactorCard />
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
      expect(authClient.twoFactor.enable).toHaveBeenCalledWith({
        password: "hunter22",
      });
    });

    expect(await screen.findByText("Save Your Backup Codes")).toBeVisible();
    expect(screen.getByText("code-one")).toBeInTheDocument();
    expect(screen.getByText("code-two")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(mockRouterPush).toHaveBeenCalledWith(
      `/auth/two-factor?totpURI=${encodeURIComponent("otpauth://totp/Test?secret=ABC")}&redirectTo=${encodeURIComponent("/settings/account")}`,
    );
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
