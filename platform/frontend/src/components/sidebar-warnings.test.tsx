import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Controllable mock return values
const mockUseSession = vi.fn();
const mockUseDefaultCredentialsEnabled = vi.fn();
const mockUseFeatures = vi.fn();

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: (...args: unknown[]) => mockUseSession(...args),
  },
}));

vi.mock("@/lib/auth.query", () => ({
  useDefaultCredentialsEnabled: (...args: unknown[]) =>
    mockUseDefaultCredentialsEnabled(...args),
}));

vi.mock("@/lib/config.query", () => ({
  useFeatures: (...args: unknown[]) => mockUseFeatures(...args),
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

    // Default: no session, no warnings
    mockUseSession.mockReturnValue({ data: null });
    mockUseDefaultCredentialsEnabled.mockReturnValue({
      data: false,
      isLoading: false,
    });
    mockUseFeatures.mockReturnValue({
      data: { globalToolPolicy: "strict" },
      isLoading: false,
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
    mockUseFeatures.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  describe("security engine warning", () => {
    it("shows slim inline warning inside alert box with Fix link", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "other@example.com" } },
      });
      mockUseFeatures.mockReturnValue({
        data: { globalToolPolicy: "permissive" },
        isLoading: false,
      });

      render(<SidebarWarnings />);

      expect(screen.getByText(/Security engine off/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fix" })).toHaveAttribute(
        "href",
        "/tool-policies",
      );
    });

    it("does not show when no session exists", () => {
      mockUseSession.mockReturnValue({ data: null });
      mockUseFeatures.mockReturnValue({
        data: { globalToolPolicy: "permissive" },
        isLoading: false,
      });

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });

    it("does not show when policy is not permissive", () => {
      mockUseSession.mockReturnValue({
        data: { user: { email: "user@example.com" } },
      });
      mockUseFeatures.mockReturnValue({
        data: { globalToolPolicy: "strict" },
        isLoading: false,
      });

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
      mockUseFeatures.mockReturnValue({
        data: { globalToolPolicy: "permissive" },
        isLoading: false,
      });

      render(<SidebarWarnings />);

      expect(screen.getByText(/Security engine off/)).toBeInTheDocument();
      expect(
        screen.getByTestId("default-credentials-warning"),
      ).toBeInTheDocument();

      // No accordion
      expect(screen.queryByText(/security warnings/)).not.toBeInTheDocument();
    });
  });
});
