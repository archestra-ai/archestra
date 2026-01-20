import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import config from "@/lib/config";
import { usePublicSsoProviders } from "@/lib/sso-provider.query.ee";
import { SsoProviderSelector } from "./sso-provider-selector.ee";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useSearchParams: vi.fn(),
}));

// Mock auth client
vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    signIn: {
      sso: vi.fn(),
    },
  },
}));

// Mock SSO providers query
vi.mock("@/lib/sso-provider.query.ee", () => ({
  usePublicSsoProviders: vi.fn(),
}));

// Mock config
vi.mock("@/lib/config", () => ({
  default: {
    enterpriseLicenseActivated: true,
  },
}));

// Mock SSO provider icons to avoid Next.js Image issues
vi.mock("./sso-provider-icons.ee", () => ({
  SsoProviderIcon: () => <span data-testid="sso-icon" />,
}));

// Mock window.location.origin
const mockOrigin = "https://app.archestra.io";
Object.defineProperty(window, "location", {
  value: { origin: mockOrigin },
  writable: true,
});

describe("SsoProviderSelector", () => {
  const mockSearchParams = {
    get: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearchParams).mockReturnValue(
      mockSearchParams as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(usePublicSsoProviders).mockReturnValue({
      data: [{ id: "1", providerId: "google" }],
      isLoading: false,
    } as ReturnType<typeof usePublicSsoProviders>);
  });

  describe("callbackURL handling", () => {
    it("should use home URL when no redirectTo param is present", async () => {
      mockSearchParams.get.mockReturnValue(null);
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should use redirectTo param when present", async () => {
      mockSearchParams.get.mockReturnValue("%2Fdashboard");
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/dashboard`,
        }),
      );
    });

    it("should handle complex encoded paths in redirectTo", async () => {
      mockSearchParams.get.mockReturnValue("%2Fsettings%2Fteams%2F123");
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/settings/teams/123`,
        }),
      );
    });
  });

  describe("malformed URL handling", () => {
    it("should fall back to home URL when redirectTo contains malformed encoding", async () => {
      // %ZZ is invalid percent encoding that causes decodeURIComponent to throw
      mockSearchParams.get.mockReturnValue("%ZZ");
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should fall back to home URL when redirectTo contains truncated encoding", async () => {
      // %2 is incomplete percent encoding
      mockSearchParams.get.mockReturnValue("%2");
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });
  });

  describe("open redirect prevention", () => {
    it("should reject absolute URLs with protocol", async () => {
      mockSearchParams.get.mockReturnValue(
        encodeURIComponent("https://evil.com/phishing"),
      );
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should reject protocol-relative URLs", async () => {
      mockSearchParams.get.mockReturnValue(
        encodeURIComponent("//evil.com/path"),
      );
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should reject paths that do not start with /", async () => {
      mockSearchParams.get.mockReturnValue(encodeURIComponent("dashboard"));
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should reject paths containing ://", async () => {
      mockSearchParams.get.mockReturnValue(
        encodeURIComponent("/redirect?url=https://evil.com"),
      );
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/`,
        }),
      );
    });

    it("should accept valid relative paths", async () => {
      mockSearchParams.get.mockReturnValue(
        encodeURIComponent("/dashboard/settings?tab=general"),
      );
      const user = userEvent.setup();

      render(<SsoProviderSelector />);

      await user.click(screen.getByRole("button", { name: /sign in with/i }));

      expect(authClient.signIn.sso).toHaveBeenCalledWith(
        expect.objectContaining({
          callbackURL: `${mockOrigin}/dashboard/settings?tab=general`,
        }),
      );
    });
  });

  describe("rendering conditions", () => {
    it("should not render when enterprise license is not activated", () => {
      vi.mocked(config).enterpriseLicenseActivated = false;

      const { container } = render(<SsoProviderSelector />);

      expect(container.firstChild).toBeNull();

      // Reset for other tests
      vi.mocked(config).enterpriseLicenseActivated = true;
    });

    it("should not render when loading", () => {
      vi.mocked(usePublicSsoProviders).mockReturnValue({
        data: [],
        isLoading: true,
      } as unknown as ReturnType<typeof usePublicSsoProviders>);

      const { container } = render(<SsoProviderSelector />);

      expect(container.firstChild).toBeNull();
    });

    it("should not render when no SSO providers are available", () => {
      vi.mocked(usePublicSsoProviders).mockReturnValue({
        data: [],
        isLoading: false,
      } as unknown as ReturnType<typeof usePublicSsoProviders>);

      const { container } = render(<SsoProviderSelector />);

      expect(container.firstChild).toBeNull();
    });

    it("should show divider by default", () => {
      render(<SsoProviderSelector />);

      expect(screen.getByText("Or continue with SSO")).toBeInTheDocument();
    });

    it("should hide divider when showDivider is false", () => {
      render(<SsoProviderSelector showDivider={false} />);

      expect(
        screen.queryByText("Or continue with SSO"),
      ).not.toBeInTheDocument();
    });
  });
});
