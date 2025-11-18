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
  });

  describe("when user is not authenticated", () => {
    beforeEach(() => {
      vi.mocked(authClient.useSession).mockReturnValue({
        data: null,
        isPending: false,
      } as ReturnType<typeof authClient.useSession>);
    });

    it("should redirect to sign-in when accessing protected page", () => {
      vi.mocked(usePathname).mockReturnValue("/dashboard");

      render(
        <WithAuthCheck>
          <MockChild />
        </WithAuthCheck>,
      );

      expect(mockRouterPush).toHaveBeenCalledWith("/auth/sign-in");
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

    it("should redirect to home when accessing auth pages", () => {
      vi.mocked(usePathname).mockReturnValue("/auth/sign-in");

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
