import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInvitationCheck } from "@/lib/auth/invitation.query";
import { useBackendConnectivity } from "@/lib/config/backend-connectivity";
import { usePublicConfig } from "@/lib/config/config.query";
import { AuthPageWithInvitationCheck } from "./auth-page-with-invitation-check";

// Mock Next.js navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

// Mock invitation query
vi.mock("@/lib/auth/invitation.query", () => ({
  useInvitationCheck: vi.fn(),
}));

// Mock backend connectivity
vi.mock("@/lib/config/backend-connectivity", () => ({
  useBackendConnectivity: vi.fn(),
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicConfig: vi.fn(),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Sparky",
}));

// Mock AuthViewWithErrorHandling
vi.mock("@/app/auth/_components/auth-view-with-error-handling", () => ({
  AuthViewWithErrorHandling: vi.fn(
    ({ path, callbackURL }: { path: string; callbackURL?: string }) => (
      <div data-testid="auth-view">
        <span data-testid="auth-path">{path}</span>
        <span data-testid="auth-callback">{callbackURL ?? "undefined"}</span>
      </div>
    ),
  ),
}));

// Mock AppLogo
vi.mock("@/components/app-logo", () => ({
  AppLogo: vi.fn(() => <div data-testid="app-logo">App Logo</div>),
}));

// Mock CommunityLinks
vi.mock("@/components/community-links", () => ({
  CommunityLinks: vi.fn(() => (
    <div data-testid="community-links">Community Links</div>
  )),
}));

// Mock DefaultCredentialsWarning
vi.mock("@/components/default-credentials-warning", () => ({
  DefaultCredentialsWarning: vi.fn(() => (
    <div data-testid="default-credentials-warning">
      Default Credentials Warning
    </div>
  )),
}));

const mockRouterPush = vi.fn();
const mockRetry = vi.fn();

describe("AuthPageWithInvitationCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: mockRouterPush,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(usePublicConfig).mockReturnValue({
      data: {
        disableBasicAuth: false,
        disableInvitations: false,
      },
      isLoading: false,
    } as ReturnType<typeof usePublicConfig>);
    // Default to connected state so existing tests work
    vi.mocked(useBackendConnectivity).mockReturnValue({
      status: "connected",
      attemptCount: 0,
      estimatedTotalAttempts: 7,
      elapsedMs: 0,
      retry: mockRetry,
    });
  });

  describe("sign-in page", () => {
    it("should render AuthView with path=sign-in", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-path")).toHaveTextContent("sign-in");
    });

    it("should show default credentials warning on sign-in page without invitation", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(
        screen.getByTestId("default-credentials-warning"),
      ).toBeInTheDocument();
    });

    it("should not show default credentials warning when invitationId is present", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: true },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
    });

    it("should not show default credentials warning when basic auth is disabled", () => {
      vi.mocked(usePublicConfig).mockReturnValue({
        data: {
          disableBasicAuth: true,
          disableInvitations: false,
        },
        isLoading: false,
      } as ReturnType<typeof usePublicConfig>);
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(
        screen.queryByTestId("default-credentials-warning"),
      ).not.toBeInTheDocument();
    });

    it("should show welcome back message for existing users with invitation", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: true },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByText("Welcome Back!")).toBeInTheDocument();
      expect(
        screen.getByText(/You already have an account/),
      ).toBeInTheDocument();
    });
  });

  describe("sign-up page", () => {
    it("should show invitation required message when no invitationId", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-up" />);

      expect(screen.getByText("Invitation Required")).toBeInTheDocument();
      expect(
        screen.getByText(/Direct sign-up is disabled/),
      ).toBeInTheDocument();
    });

    it("should show loading spinner while checking invitation", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: true,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-up" />);

      // Should not show the invitation required message while loading
      expect(screen.queryByText("Invitation Required")).not.toBeInTheDocument();
      // AuthView should not be rendered while loading
      expect(screen.queryByTestId("auth-view")).not.toBeInTheDocument();
    });

    it("should redirect existing users from sign-up to sign-in", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: true },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-up" />);

      expect(mockRouterPush).toHaveBeenCalledWith(
        "/auth/sign-in?invitationId=inv123",
      );
    });

    it("should render sign-up form for new users with invitation", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: false },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-up" />);

      expect(screen.getByTestId("auth-view")).toBeInTheDocument();
      expect(screen.getByTestId("auth-path")).toHaveTextContent("sign-up");
    });
  });

  describe("callbackURL handling", () => {
    it("should pass invitation callback URL for sign-in with invitationId", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: true },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent(
        "/auth/sign-in?invitationId=inv123",
      );
    });

    it("should pass invitation callback URL for sign-up with invitationId", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => (key === "invitationId" ? "inv123" : null)),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: { userExists: false },
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-up" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent(
        "/auth/sign-up?invitationId=inv123",
      );
    });

    it("should pass validated redirectTo path when no invitationId", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) =>
          key === "redirectTo" ? "%2Fdashboard" : null,
        ),
        toString: vi.fn(() => "redirectTo=%2Fdashboard"),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent(
        "/dashboard",
      );
    });

    it("should preserve OAuth authorize params for MCP client auth redirects", () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: "https://claude.ai/oauth/claude-code-client-metadata",
        redirect_uri: "http://localhost:54022/callback",
        scope: "mcp offline_access",
        state: "state123",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        resource: "http://localhost:9000/v1/mcp/default-mcp-gateway",
        exp: "123",
        sig: "abc",
      });
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) => params.get(key)),
        toString: vi.fn(() => params.toString()),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback").textContent).toBe(
        `/api/auth/oauth2/authorize?${params.toString()}`,
      );
    });

    it("should fallback to / for invalid redirectTo", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) =>
          key === "redirectTo" ? encodeURIComponent("https://evil.com") : null,
        ),
        toString: vi.fn(() => "redirectTo=https%3A%2F%2Fevil.com"),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent("/");
    });

    it("should fallback to / when redirectTo is not provided", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
        toString: vi.fn(() => ""),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent("/");
    });

    it("should handle complex paths with query parameters", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) =>
          key === "redirectTo"
            ? "%2Fsearch%3Fq%3Dhello%26filter%3Dactive"
            : null,
        ),
        toString: vi.fn(
          () => "redirectTo=%2Fsearch%3Fq%3Dhello%26filter%3Dactive",
        ),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent(
        "/search?q=hello&filter=active",
      );
    });

    it("should reject protocol-relative URLs", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) =>
          key === "redirectTo" ? encodeURIComponent("//evil.com") : null,
        ),
        toString: vi.fn(() => "redirectTo=%2F%2Fevil.com"),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-callback")).toHaveTextContent("/");
    });
  });

  describe("backend connectivity", () => {
    it("should show connecting message instead of login form when backend is connecting", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);
      vi.mocked(useBackendConnectivity).mockReturnValue({
        status: "connecting",
        attemptCount: 0,
        estimatedTotalAttempts: 7,
        elapsedMs: 0,
        retry: mockRetry,
      });

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByText("Connecting...")).toBeInTheDocument();
      expect(screen.queryByTestId("auth-view")).not.toBeInTheDocument();
    });

    it("should show retry information when connection attempts have failed", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);
      vi.mocked(useBackendConnectivity).mockReturnValue({
        status: "connecting",
        attemptCount: 3,
        estimatedTotalAttempts: 7,
        elapsedMs: 5000,
        retry: mockRetry,
      });

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(
        screen.getByText(/Still trying to connect, attempt 3 \/ 7/),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("auth-view")).not.toBeInTheDocument();
    });

    it("should show unreachable message instead of login form when backend is unreachable", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);
      vi.mocked(useBackendConnectivity).mockReturnValue({
        status: "unreachable",
        attemptCount: 5,
        estimatedTotalAttempts: 7,
        elapsedMs: 60000,
        retry: mockRetry,
      });

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByText("Unable to Connect")).toBeInTheDocument();
      expect(screen.getByText("Server Unreachable")).toBeInTheDocument();
      expect(screen.queryByTestId("auth-view")).not.toBeInTheDocument();
    });

    it("should call retry when Try Again button is clicked", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);
      vi.mocked(useBackendConnectivity).mockReturnValue({
        status: "unreachable",
        attemptCount: 5,
        estimatedTotalAttempts: 7,
        elapsedMs: 60000,
        retry: mockRetry,
      });

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      const retryButton = screen.getByRole("button", { name: /Try Again/i });
      fireEvent.click(retryButton);

      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it("should show login form when backend is connected", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn().mockReturnValue(null),
      } as unknown as ReturnType<typeof useSearchParams>);
      vi.mocked(useInvitationCheck).mockReturnValue({
        data: undefined,
        isLoading: false,
      } as ReturnType<typeof useInvitationCheck>);
      vi.mocked(useBackendConnectivity).mockReturnValue({
        status: "connected",
        attemptCount: 0,
        estimatedTotalAttempts: 7,
        elapsedMs: 0,
        retry: mockRetry,
      });

      render(<AuthPageWithInvitationCheck path="sign-in" />);

      expect(screen.getByTestId("auth-view")).toBeInTheDocument();
      expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
      expect(screen.queryByText("Unable to Connect")).not.toBeInTheDocument();
    });
  });
});
