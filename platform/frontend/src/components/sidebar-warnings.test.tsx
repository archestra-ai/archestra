import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/auth.query");

vi.mock("@/lib/config/config.query");

vi.mock("@archestra/shared", () => ({
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

import {
  useDefaultCredentialsEnabled,
  useHasPermissions,
  useSession,
} from "@/lib/auth/auth.query";
import { useDisableBasicAuth, useFeature } from "@/lib/config/config.query";
import { SidebarWarnings } from "./sidebar-warnings";

describe("SidebarWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no session, no warnings, has both org and agent settings update permission
    vi.mocked(useSession).mockReturnValue({
      data: null,
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
      data: false,
      isLoading: false,
    } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
    vi.mocked(useFeature).mockReturnValue(
      "strict" as ReturnType<typeof useFeature>,
    );
    vi.mocked(useDisableBasicAuth).mockReturnValue(false);
    vi.mocked(useHasPermissions).mockImplementation((permissions) => {
      if ("organization" in (permissions as Record<string, unknown>)) {
        return { data: true } as ReturnType<typeof useHasPermissions>;
      }
      if ("agentSettings" in (permissions as Record<string, unknown>)) {
        return { data: true } as ReturnType<typeof useHasPermissions>;
      }
      return { data: false } as ReturnType<typeof useHasPermissions>;
    });
  });

  it("renders nothing when there are no warnings", () => {
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading credentials", () => {
    vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while loading features", () => {
    vi.mocked(useSession).mockReturnValue({
      data: { user: { email: "admin@example.com" } },
    } as unknown as ReturnType<typeof useSession>);
    vi.mocked(useFeature).mockReturnValue(undefined);
    const { container } = render(<SidebarWarnings />);
    expect(container.firstChild).toBeNull();
  });

  describe("security engine warning", () => {
    it("shows slim inline warning inside alert box with Fix link", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "other@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useFeature).mockReturnValue(
        "permissive" as ReturnType<typeof useFeature>,
      );

      render(<SidebarWarnings />);

      expect(screen.getByText(/Security engine off/)).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Fix" })).toHaveAttribute(
        "href",
        "/mcp/tool-guardrails",
      );
    });

    it("does not show when no session exists", () => {
      vi.mocked(useSession).mockReturnValue({
        data: null,
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useFeature).mockReturnValue(
        "permissive" as ReturnType<typeof useFeature>,
      );

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });

    it("does not show when policy is not permissive", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "user@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useFeature).mockReturnValue(
        "strict" as ReturnType<typeof useFeature>,
      );

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("default credentials warning", () => {
    it("renders DefaultCredentialsWarning with slim prop", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);

      render(<SidebarWarnings />);

      const warning = screen.getByTestId("default-credentials-warning");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveAttribute("data-slim", "true");
    });

    it("does not show for non-admin users", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "other@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });

    it("does not show when basic auth is disabled", () => {
      vi.mocked(useDisableBasicAuth).mockReturnValue(true);
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);

      render(<SidebarWarnings />);
      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
    });

    it("does not show when credentials are not default", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: false,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe("both warnings", () => {
    it("shows both warnings inside a single alert box without accordion", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
      vi.mocked(useFeature).mockReturnValue(
        "permissive" as ReturnType<typeof useFeature>,
      );

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
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
      vi.mocked(useHasPermissions).mockImplementation((permissions) => {
        if ("organization" in (permissions as Record<string, unknown>)) {
          return { data: false } as ReturnType<typeof useHasPermissions>;
        }
        if ("agentSettings" in (permissions as Record<string, unknown>)) {
          return { data: true } as ReturnType<typeof useHasPermissions>;
        }
        return { data: false } as ReturnType<typeof useHasPermissions>;
      });

      const { container } = render(<SidebarWarnings />);
      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it("hides security engine warning when user lacks agentSettings:update permission", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "other@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useFeature).mockReturnValue(
        "permissive" as ReturnType<typeof useFeature>,
      );
      vi.mocked(useHasPermissions).mockImplementation((permissions) => {
        if ("organization" in (permissions as Record<string, unknown>)) {
          return { data: true } as ReturnType<typeof useHasPermissions>;
        }
        if ("agentSettings" in (permissions as Record<string, unknown>)) {
          return { data: false } as ReturnType<typeof useHasPermissions>;
        }
        return { data: false } as ReturnType<typeof useHasPermissions>;
      });

      const { container } = render(<SidebarWarnings />);
      expect(screen.queryByText(/Security engine off/)).not.toBeInTheDocument();
      expect(container.firstChild).toBeNull();
    });

    it("hides both warnings when user lacks agentSettings:update permission", () => {
      vi.mocked(useSession).mockReturnValue({
        data: { user: { email: "admin@example.com" } },
      } as unknown as ReturnType<typeof useSession>);
      vi.mocked(useDefaultCredentialsEnabled).mockReturnValue({
        data: true,
        isLoading: false,
      } as unknown as ReturnType<typeof useDefaultCredentialsEnabled>);
      vi.mocked(useFeature).mockReturnValue(
        "permissive" as ReturnType<typeof useFeature>,
      );
      vi.mocked(useHasPermissions).mockImplementation(
        () => ({ data: false }) as ReturnType<typeof useHasPermissions>,
      );

      const { container } = render(<SidebarWarnings />);
      expect(container.firstChild).toBeNull();
    });
  });
});
