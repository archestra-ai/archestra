import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable mock return values
const mockUseSession = vi.fn();
const mockUseDefaultCredentialsEnabled = vi.fn();
const mockUseHasPermissions = vi.fn();
const mockUseFeature = vi.fn();
const mockUseDisableBasicAuth = vi.fn();

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: (...args: unknown[]) => mockUseSession(...args),
  },
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useDefaultCredentialsEnabled: (...args: unknown[]) =>
    mockUseDefaultCredentialsEnabled(...args),
  useHasPermissions: (...args: unknown[]) => mockUseHasPermissions(...args),
}));

vi.mock("@/lib/config/config.query", () => ({
  useFeature: (...args: unknown[]) => mockUseFeature(...args),
  useDisableBasicAuth: (...args: unknown[]) => mockUseDisableBasicAuth(...args),
}));

vi.mock("@shared", () => ({
  DEFAULT_ADMIN_EMAIL: "admin@example.com",
  DEFAULT_ADMIN_PASSWORD: "admin",
}));

// Mock DefaultCredentialsWarning to simplify tests
vi.mock("@/components/default-credentials-warning", () => ({
  DefaultCredentialsWarning: ({ slim }: { slim?: boolean }) => (
    <div data-testid="default-credentials-warning" data-slim={slim}>
      Default Admin Credentials
    </div>
  ),
}));

import { SidebarWarnings } from "./sidebar-warnings";

describe("SidebarWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no session, no warnings, has both org and agent settings update permission
    mockUseSession.mockReturnValue({ data: null });
    mockUseDefaultCredentialsEnabled.mockReturnValue({
      data: false,
      isLoading: false,
    });
    mockUseFeature.mockReturnValue("strict");
    mockUseDisableBasicAuth.mockReturnValue(false);
    mockUseHasPermissions.mockImplementation((permissions) => {
      if ("organization" in (permissions as Record<string, unknown>)) {
        return { data: true };
      }
      if ("agentSettings" in (permissions as Record<string, unknown>)) {
        return { data: true };
      }
      return { data: false };
    });
  });

  it("renders nothing when there are no warnings", () => {
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading credentials", () => {
    mockUseDefaultCredentialsEnabled.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading features", () => {
    mockUseSession.mockReturnValue({
      data: { user: { email: "admin@example.com" } },
    });
    mockUseFeature.mockReturnValue(undefined);
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  describe("security engine warning", () => {
    it("shows slim inline warning inside alert box with Fix link", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "other@example.com" } },
      });
      mockUseFeature.mockReturnValue("permissive");

      render(<SidebarWarnings />);

      expect(screen.getByText(/Security engine off/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fix" })).toHaveAttribute(
        "href",
        "/mcp/tool-policies",
      );
    });

    it("does not show when no session exists", () => {
      mockUseSession.mockReturnValue({ data: null });
      mockUseFeature.mockReturnValue("permissive");

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });

    it("does not show when policy is not permissive", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "user@example.com" } },
      });
      mockUseFeature.mockReturnValue("strict");

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("default credentials warning", () => {
    it("renders DefaultCredentialsWarning with slim prop", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });

      render(<SidebarWarnings />);

      const warning = screen.getByTestId("default-credentials-warning");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveAttribute("data-slim", "true");
    });

    it("does not show for non-admin users", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "other@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });

    it("does not show when basic auth is disabled", () => {
      mockUseDisableBasicAuth.mockReturnValue(true);
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });

      render(<SidebarWarnings />);
      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
    });

    it("does not show when credentials are not default", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: false,
        isLoading: false,
      });

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("both warnings", () => {
    it("shows both warnings inside a single alert box without accordion", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });
      mockUseFeature.mockReturnValue("permissive");

      render(<SidebarWarnings />);

      expect(screen.getByText(/Security engine off/)).toBeInTheDocument();
      expect(
        screen.getByTestId("default-credentials-warning"),
      ).toBeInTheDocument();

      // No accordion
      expect(screen.queryByText(/security warnings/)).not.toBeInTheDocument();
    });
  });

  describe("permission gating", () => {
    it("hides default credentials warning when user lacks organization:update permission", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });
      mockUseHasPermissions.mockImplementation((permissions) => {
        if ("organization" in (permissions as Record<string, unknown>)) {
          return { data: false };
        }
        if ("agentSettings" in (permissions as Record<string, unknown>)) {
          return { data: true };
        }
        return { data: false };
      });

      const { container } = render(<SidebarWarnings />);
      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it("hides security engine warning when user lacks agentSettings:update permission", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "other@example.com" } },
      });
      mockUseFeature.mockReturnValue("permissive");
      mockUseHasPermissions.mockImplementation((permissions) => {
        if ("organization" in (permissions as Record<string, unknown>)) {
          return { data: true };
        }
        if ("agentSettings" in (permissions as Record<string, unknown>)) {
          return { data: false };
        }
        return { data: false };
      });

      const { container } = render(<SidebarWarnings />);
      expect(screen.queryByText(/Security engine off/)).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it("hides both warnings when user lacks agentSettings:update permission", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      });
      mockUseDefaultCredentialsEnabled.mockReturnValue({
        data: true,
        isLoading: false,
      });
      mockUseFeature.mockReturnValue("permissive");
      mockUseHasPermissions.mockImplementation(() => ({ data: false }));

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });
});
