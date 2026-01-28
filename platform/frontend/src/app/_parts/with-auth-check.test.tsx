import * as Sentry from "@sentry/nextjs";
import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { WithAuthCheck } from "./with-auth-check";

// Mock Sentry
vi.mock("@sentry/nextjs", () => ({
  setUser: vi.fn(),
}));

// Mock Next.js router and navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  usePathname: vi.fn(),
}));

// Mock auth client
vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    useSession: vi.fn(),
  },
}));

// Mock auth query
vi.mock("@/lib/auth.query", () => ({
  useHasPermissions: vi.fn(),
}));

// Mock shared module
vi.mock("@shared", () => ({
  requiredPagePermissionsMap: {
    "/protected": { "organization:read": ["read"] },
    "/admin": { "organization:write": ["write"] },
  },
}));

const mockRouterPush = vi.fn();
const MockChild = () => (
  <div data-testid="protected-content">Protected Content</div>
);

// Helper to set window.location for tests
const setWindowLocation = (pathname: string, search = "") => {
  Object.defineProperty(window, "location", {
    value: {
      pathname,
      search,
      href: `http://localhost${pathname}${search}`,
    },
    writable: true,
  });
};

describe("WithAuthCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useHasPermissions).mockReturnValue({
      data: true,
      isPending: false,
    } as ReturnType<typeof useHasPermissions>);
    // Reset window.location to default state
    setWindowLocation("/", "");
  });

  describe("when user is not authenticated", () => {
    beforeEach(() => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
    });

    it("should redirect to sign-in with redirectTo param when accessing protected page", () => {
      vi.mocked(usePathname).mockReturnValue("/dashboard");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith(
        "/auth/sign-in?redirectTo=%2Fdashboard",
      );
    });

    it("should redirect to sign-in with encoded redirectTo param for complex paths", () => {
      vi.mocked(usePathname).mockReturnValue("/settings/teams/123");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith(
        "/auth/sign-in?redirectTo=%2Fsettings%2Fteams%2F123",
      );
    });

    it("should preserve query parameters in redirectTo param", () => {
      vi.mocked(usePathname).mockReturnValue("/search");
      setWindowLocation("/search", "?q=hello&filter=active");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith(
        "/auth/sign-in?redirectTo=%2Fsearch%3Fq%3Dhello%26filter%3Dactive",
      );
    });

    it("should not add ? when there are no query parameters", () => {
      vi.mocked(usePathname).mockReturnValue("/dashboard");
      setWindowLocation("/dashboard", "");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith(
        "/auth/sign-in?redirectTo=%2Fdashboard",
      );
    });

    it("should allow access to auth pages", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    it("should allow access to sign-out page without adding redirectTo", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-out");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      // Should not redirect at all - sign-out is an auth page
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });

  describe("when user is authenticated", () => {
    beforeEach(() => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: {
          user: { id: "user123", email: "test@example.com" },
          session: { id: "session123" },
        },
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
    });

    it("should redirect to home when accessing auth pages without redirectTo", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");
      setWindowLocation("/auth/sign-in", "");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });

    it("should redirect to home when redirectTo is empty string", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");
      setWindowLocation("/auth/sign-in", "?redirectTo=");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });

    it("should redirect to redirectTo param when accessing auth pages after login", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");
      setWindowLocation("/auth/sign-in", "?redirectTo=%2Flogs%2Fllm-proxy");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith("/logs/llm-proxy");
    });

    it("should ignore malicious redirectTo param and redirect to home", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");
      const maliciousUrl = encodeURIComponent("https://evil.com/phishing");
      setWindowLocation("/auth/sign-in", `?redirectTo=${maliciousUrl}`);

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith("/");
    });

    it("should allow access to unprotected pages", () => {
      vi.mocked(usePathname).mockReturnValue("/dashboard");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    it("should allow access to sign-out page when authenticated", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-out");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      // Sign-out is a special auth page - should not redirect
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });

  describe("when auth check is pending", () => {
    beforeEach(() => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: true,
      } as ReturnType<typeof authClient.useSession>);
    });

    it("should render nothing while checking auth", () => {
      vi.mocked(usePathname).mockReturnValue("/dashboard");

      const { container } = render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(container.firstChild).toBeNull();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });

  describe("special auth pages (/auth/two-factor)", () => {
    it("should allow access to /auth/two-factor when not authenticated (2FA verification during login)", () => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
      vi.mocked(usePathname).mockReturnValue("/auth/two-factor");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    it("should allow access to /auth/two-factor when authenticated (2FA setup)", () => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: {
          user: { id: "user123", email: "test@example.com" },
          session: { id: "session123" },
        },
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
      vi.mocked(usePathname).mockReturnValue("/auth/two-factor");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });

    it("should allow access to /auth/two-factor sub-paths", () => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
      vi.mocked(usePathname).mockReturnValue("/auth/two-factor/setup");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByTestId("protected-content")).toBeInTheDocument();
    });
  });

  describe("Sentry user context", () => {
    it("should set Sentry user context when user is authenticated", () => {
      const mockUser = {
        id: "user123",
        email: "test@example.com",
        name: "Test User",
      };

      vi.mocked(authClient.useSession).mockReturnValue({
        data: {
          user: mockUser,
          session: { id: "session123" },
        },
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);

      vi.mocked(usePathname).mockReturnValue("/dashboard");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: "user123",
        email: "test@example.com",
        username: "Test User",
      });
    });

    it("should use email as username when name is not available", () => {
      const mockUser = {
        id: "user456",
        email: "another@example.com",
      };

      vi.mocked(authClient.useSession).mockReturnValue({
        data: {
          user: mockUser,
          session: { id: "session456" },
        },
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);

      vi.mocked(usePathname).mockReturnValue("/dashboard");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: "user456",
        email: "another@example.com",
        username: "another@example.com",
      });
    });

    it("should clear Sentry user context when user is not authenticated", () => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);

      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(Sentry.setUser).toHaveBeenCalledWith(null);
    });

    it("should handle Sentry errors silently", () => {
      vi.mocked(Sentry.setUser).mockImplementationOnce(() => {
        throw new Error("Sentry error");
      });

      vi.mocked(authClient.useSession).mockReturnValue({
        data: {
          user: { id: "user789", email: "error@example.com" },
          session: { id: "session789" },
        },
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);

      vi.mocked(usePathname).mockReturnValue("/dashboard");

      // Should not throw
      expect(() => {
        render(
          <WithAuthCheck>
            <MockChild />
          </WithAuthCheck>,
        );
      }).not.toThrow();
    });
  });
});
