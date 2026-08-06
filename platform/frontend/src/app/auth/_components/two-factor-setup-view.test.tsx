import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useOrganization } from "@/lib/organization.query";
import { TwoFactorSetupView } from "./two-factor-setup-view";

vi.mock("next/navigation");

vi.mock("@/lib/clients/auth/auth-client");

vi.mock("@/lib/hooks/use-app-name");

vi.mock("@/lib/organization.query");

vi.mock("@/lib/auth/auth.query", () => ({
  useSession: vi.fn(),
  authQueryKeys: { all: ["auth"] },
}));

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

/** Walks password → QR, leaving the view on the code-entry step. */
async function enroll(user: ReturnType<typeof userEvent.setup>) {
  renderView();
  await user.type(screen.getByLabelText("Password"), "hunter22");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  return screen.findByText("Scan the QR Code");
}

describe("TwoFactorSetupView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAppName).mockReturnValue("Acme AI");
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: "user-1", twoFactorEnabled: false } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useOrganization).mockReturnValue({
      data: { requireTwoFactor: true },
    } as unknown as ReturnType<typeof useOrganization>);
    vi.mocked(authClient.twoFactor.enable).mockResolvedValue({
      data: {
        totpURI: "otpauth://totp/Test?secret=ABC",
        backupCodes: ["code-one", "code-two"],
      },
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.enable>>);
    vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.verifyTotp>>);
  });

  it("enrolls in the standard order: password, QR + code, then backup codes", async () => {
    const user = userEvent.setup();

    expect(
      screen.queryByText("Save Your Backup Codes"),
    ).not.toBeInTheDocument();
    await enroll(user);

    await waitFor(() => {
      // `issuer` is what the authenticator app shows beside the code, so it
      // must follow the deployment's brand.
      expect(authClient.twoFactor.enable).toHaveBeenCalledWith({
        password: "hunter22",
        issuer: "Acme AI",
      });
    });

    // Backup codes must not appear before the authenticator is proven to work.
    expect(screen.queryByText("code-one")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("One-time code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByText("Save Your Backup Codes")).toBeVisible();
    expect(screen.getByText("code-one")).toBeInTheDocument();
    expect(screen.getByText("code-two")).toBeInTheDocument();
  });

  it("requires downloading the backup codes before finishing", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn().mockReturnValue("blob:codes");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    await enroll(user);
    await user.type(screen.getByLabelText("One-time code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText("Save Your Backup Codes");

    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(createObjectURL).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    vi.unstubAllGlobals();
  });

  it("offers an escape hatch to sign in as a different user", async () => {
    renderView();

    expect(
      screen.getByRole("link", { name: "Sign in as a different user" }),
    ).toHaveAttribute("href", "/auth/sign-out");
  });
});
