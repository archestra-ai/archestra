import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";
import { TwoFactorSetupView } from "./two-factor-setup-view";

vi.mock("next/navigation");

vi.mock("@/lib/clients/auth/auth-client");

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(),
}));

const mockRouterPush = vi.fn();

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TwoFactorSetupView />
    </QueryClientProvider>,
  );
}

describe("TwoFactorSetupView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1", twoFactorEnabled: false } },
    } as unknown as ReturnType<typeof useSession>);
  });

  it("walks password → backup codes → authenticator setup", async () => {
    const user = userEvent.setup();
    vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
      data: {
        totpURI: "otpauth://totp/Test?secret=ABC",
        backupCodes: ["code-one", "code-two"],
      },
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.enable>>);

    renderView();

    expect(
      screen.getByText(/Your organization requires two-factor authentication/),
    ).toBeVisible();

    await user.type(screen.getByLabelText("Password"), "hunter22");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => {
      // The issuer is what the authenticator app shows beside the code, so it
      // must follow the deployment's brand.
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
      `/auth/two-factor?totpURI=${encodeURIComponent("otpauth://totp/Test?secret=ABC")}&redirectTo=${encodeURIComponent("/")}`,
    );
  });

  it("offers an escape hatch to sign in as a different user", async () => {
    renderView();

    expect(
      screen.getByRole("link", { name: "Sign in as a different user" }),
    ).toHaveAttribute("href", "/auth/sign-out");
  });
});
