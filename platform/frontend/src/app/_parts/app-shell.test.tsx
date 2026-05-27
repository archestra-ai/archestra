import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./app-shell";

const mockUsePathname = vi.fn();
const mockUseHasPermissions = vi.fn();
const mockUseActiveSiteNotification = vi.fn();

vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: () => mockUseHasPermissions(),
}));

vi.mock("@/lib/site-notification.query", () => ({
  useActiveSiteNotification: () => mockUseActiveSiteNotification(),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarCircleToggle: () => <button type="button">Toggle Sidebar</button>,
  SidebarTrigger: () => <button type="button">Open Sidebar</button>,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/components/version", () => ({
  Version: () => <div data-testid="version">Version</div>,
}));

vi.mock("@/components/navigation-status-provider", () => ({
  NavigationStatusProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useNavigationStatus: () => ({ isNavigating: false }),
}));

vi.mock("@/components/conversation-search-provider", () => ({
  ConversationSearchProvider: () => <div data-testid="conversation-search" />,
}));

vi.mock("@/components/impersonation-banner", () => ({
  ImpersonationBanner: () => <div data-testid="impersonation-banner" />,
}));

vi.mock("@/components/onboarding-dialog-wrapper", () => ({
  OnboardingDialogWrapper: () => <div data-testid="onboarding-dialog" />,
}));

vi.mock("./maintenance-mode-overlay", () => ({
  MaintenanceModeOverlay: () => <div data-testid="maintenance-overlay" />,
}));

vi.mock("./sidebar", () => ({
  AppSidebar: () => <aside data-testid="app-sidebar" />,
}));

vi.mock("./site-notification-bar", () => ({
  SiteNotificationBar: ({ content }: { content: string }) => (
    <div data-testid="site-notification">{content}</div>
  ),
}));

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/chat");
    mockUseHasPermissions.mockReturnValue({ data: true, isSuccess: true });
    mockUseActiveSiteNotification.mockReturnValue({ data: null });
  });

  it("keeps the version footer after naturally-sized page content", () => {
    render(
      <AppShell>
        <div data-testid="page-content">Page content</div>
      </AppShell>,
    );

    const versionParent = screen.getByTestId("version").parentElement;
    const contentParent = screen.getByTestId("page-content").parentElement;

    expect(versionParent).toHaveClass("flex-1", "min-w-0", "flex", "flex-col");
    expect(versionParent).not.toHaveClass("min-h-0");
    expect(contentParent).toHaveClass("flex-1", "flex", "flex-col");
    expect(contentParent).not.toHaveClass("min-h-0");
  });
});
