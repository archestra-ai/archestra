import { fireEvent, render, screen } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackendConnectivity } from "@/lib/backend-connectivity";
import { useInvitationCheck } from "@/lib/invitation.query";
import { AuthPageWithInvitationCheck } from "./auth-page-with-invitation-check";

// Mock Next.js navigation
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

// Mock invitation query
vi.mock("@/lib/invitation.query", () => ({
  useInvitationCheck: vi.fn(),
}));

// Mock backend connectivity
vi.mock("@/lib/backend-connectivity", () => ({
  useBackendConnectivity: vi.fn(),
}));

// Mock config
vi.mock("@/lib/config", () => ({
  default: {
    disableBasicAuth: false,
    enterpriseLicenseActivated: false,
  },
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

    it("should fallback to / for invalid redirectTo", () => {
      vi.mocked(useSearchParams).mockReturnValue({
        get: vi.fn((key: string) =>
          key === "redirectTo" ? encodeURIComponent("https://evil.com") : null,
        ),
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
