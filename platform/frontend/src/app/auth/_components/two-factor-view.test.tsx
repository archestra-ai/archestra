import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import { TwoFactorView } from "./two-factor-view";

// Radix Checkbox needs ResizeObserver
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    twoFactor: {
      verifyTotp: vi.fn(),
    },
  },
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
      <TwoFactorView />
    </QueryClientProvider>,
  );
}

function mockSearchParams(params: Record<string, string>) {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(params) as unknown as ReturnType<
      typeof useSearchParams
    >,
  );
}

describe("TwoFactorView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authClient.twoFactor.verifyTotp).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.twoFactor.verifyTotp>>);
  });

  describe("verification during sign-in (no totpURI)", () => {
    it("verifies the code with the trust-device choice", async () => {
      const user = userEvent.setup();
      mockSearchParams({});
      renderView();

      expect(
        screen.getByText("Enter the 6-digit code from your authenticator app"),
      ).toBeInTheDocument();

      await user.type(screen.getByLabelText("One-time code"), "123456");
      await user.click(screen.getByLabelText("Trust this device"));
      await user.click(screen.getByRole("button", { name: "Verify" }));

      await waitFor(() => {
        expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
          code: "123456",
          trustDevice: true,
        });
      });
    });

    it("rejects non-6-digit codes without calling the API", async () => {
      const user = userEvent.setup();
      mockSearchParams({});
      renderView();

      await user.type(screen.getByLabelText("One-time code"), "123");
      await user.click(screen.getByRole("button", { name: "Verify" }));

      expect(
        await screen.findByText(
          "Enter the 6-digit code from your authenticator app",
          { selector: "p" },
        ),
      ).toBeInTheDocument();
      expect(authClient.twoFactor.verifyTotp).not.toHaveBeenCalled();
    });

    it("links to backup-code recovery preserving redirectTo", () => {
      mockSearchParams({ redirectTo: "/chat" });
      renderView();

      expect(
        screen.getByRole("link", { name: /use a backup code/i }),
      ).toHaveAttribute("href", "/auth/recover-account?redirectTo=%2Fchat");
    });
  });

  describe("authenticator setup (with totpURI)", () => {
    it("shows the QR code and verifies without trustDevice", async () => {
      const user = userEvent.setup();
      mockSearchParams({
        totpURI: "otpauth://totp/Test:user@example.com?secret=ABC",
      });
      const { container } = renderView();

      expect(container.querySelector("svg")).toBeInTheDocument();
      expect(
        screen.queryByLabelText("Trust this device"),
      ).not.toBeInTheDocument();

      await user.type(screen.getByLabelText("One-time code"), "654321");
      await user.click(screen.getByRole("button", { name: "Verify" }));

      await waitFor(() => {
        expect(authClient.twoFactor.verifyTotp).toHaveBeenCalledWith({
          code: "654321",
          trustDevice: undefined,
        });
      });
    });
  });
});
