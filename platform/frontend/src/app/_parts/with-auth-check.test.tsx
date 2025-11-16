import { render, screen } from "@testing-library/react";
import { usePathname, useRouter } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasPermission } from "@/lib/auth.utils";
import { authClient } from "@/lib/clients/auth/auth-client";
import { WithAuthCheck } from "./with-auth-check";

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

// Mock auth utils
vi.mock("@/lib/auth.utils", () => ({
  hasPermission: vi.fn(),
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
    vi.mocked(hasPermission).mockResolvedValue(true);
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
});
