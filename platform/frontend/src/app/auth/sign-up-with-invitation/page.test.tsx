import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRouter, useSearchParams } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/clients/auth/auth-client";
import SignUpWithInvitationPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

vi.mock("@/lib/clients/auth/auth-client", () => ({
  authClient: {
    signUp: {
      email: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/invitation.query", () => ({
  useInvitationCheck: vi.fn(() => ({
    data: {
      userExists: false,
      invitation: {
        status: "pending",
      },
    },
    isLoading: false,
  })),
}));

vi.mock("@/lib/hooks/use-app-name", () => ({
  useAppName: () => "Archestra",
}));

vi.mock("@/components/app-logo", () => ({
  AppLogo: () => <div data-testid="app-logo">App Logo</div>,
}));

vi.mock("@/components/community-links", () => ({
  CommunityLinks: () => (
    <div data-testid="community-links">Community Links</div>
  ),
}));

vi.mock("@/components/loading", () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading</div>,
}));

vi.mock("@/app/_parts/error-boundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));

const routerReplace = vi.fn();

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SignUpWithInvitationPage />
    </QueryClientProvider>,
  );
}

describe("SignUpWithInvitationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
      replace: routerReplace,
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "invitationId=inv-123&email=yoo%40example.com&name=Yoo",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );
    vi.mocked(authClient.signUp.email).mockResolvedValue({
      data: {},
      error: null,
    } as Awaited<ReturnType<typeof authClient.signUp.email>>);
  });

  it("submits invitation signup and redirects to a clean chat URL", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(screen.getByText("Email: yoo@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Yoo");
    expect(screen.getByLabelText("Email")).toHaveValue("yoo@example.com");

    await user.type(screen.getByLabelText("Password"), "password123");
    await user.click(screen.getByRole("button", { name: "Create an account" }));

    await waitFor(() => {
      expect(authClient.signUp.email).toHaveBeenCalledWith({
        name: "Yoo",
        email: "yoo@example.com",
        password: "password123",
        callbackURL: "/chat",
        invitationId: "inv-123",
      });
    });
    expect(routerReplace).toHaveBeenCalledWith("/chat");
  });
});
