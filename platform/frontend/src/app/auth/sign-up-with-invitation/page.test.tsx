import { render, screen, waitFor } from "@testing-library/react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignUpWithInvitationPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
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

vi.mock("@daveyplate/better-auth-ui", () => ({
  AuthView: () => <DelayedAuthView />,
}));

function DelayedAuthView() {
  const [showInputs, setShowInputs] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowInputs(true), 25);
    return () => window.clearTimeout(timer);
  }, []);

  if (!showInputs) {
    return <div data-testid="auth-view-loading">AuthView loading</div>;
  }

  return (
    <form>
      <input name="name" />
      <input name="email" type="email" />
      <input name="password" type="password" />
    </form>
  );
}

describe("SignUpWithInvitationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({
      push: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams(
        "invitationId=inv-123&email=yoo%40example.com&name=Yoo",
      ) as unknown as ReturnType<typeof useSearchParams>,
    );
  });

  it("prefills invitation email and name even when auth inputs mount late", async () => {
    render(<SignUpWithInvitationPage />);

    expect(screen.getByText("Email: yoo@example.com")).toBeInTheDocument();

    await waitFor(() => {
      expect(document.querySelector('input[name="email"]')).toBeInTheDocument();
    });

    const emailInput = document.querySelector<HTMLInputElement>(
      'input[name="email"]',
    );
    const nameInput =
      document.querySelector<HTMLInputElement>('input[name="name"]');

    expect(emailInput?.value).toBe("yoo@example.com");
    expect(nameInput?.value).toBe("Yoo");
  });
});
