import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let mockPathname = "/chat";
let mockShouldCollapse = false;
let mockPermissionLoaded = true;
let mockCanReadSiteNotification = true;
let mockPublicConfig: {
  maintenance?: { enabled: boolean; message: string | null };
} | null = {
  maintenance: { enabled: false, message: null },
};
let mockSiteNotification: {
  markdown: string | null;
  expiresAt: string | null;
} | null = null;

vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
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

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
  SidebarTrigger: () => <button type="button">Sidebar trigger</button>,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/components/version", () => ({
  Version: () => <div data-testid="version">Version</div>,
}));

vi.mock("@/lib/auth/auth.query", () => ({
  useHasPermissions: (permissions: Record<string, string[]>) => {
    if ("simpleView" in permissions) {
      return {
        data: mockShouldCollapse,
        isSuccess: mockPermissionLoaded,
      };
    }

    if ("siteNotification" in permissions) {
      return {
        data: mockCanReadSiteNotification,
        isSuccess: true,
      };
    }

    return {
      data: false,
      isSuccess: true,
    };
  },
}));

vi.mock("@/lib/config/config.query", () => ({
  usePublicConfig: () => ({
    data: mockPublicConfig,
    isLoading: false,
  }),
}));

vi.mock("@/lib/organization.query", () => ({
  useSiteNotification: () => ({
    data: mockSiteNotification,
  }),
}));

vi.mock("./sidebar", () => ({
  AppSidebar: () => <div data-testid="app-sidebar">Sidebar</div>,
}));

import { AppShell } from "./app-shell";

describe("AppShell", () => {
  beforeEach(() => {
    mockPathname = "/chat";
    mockShouldCollapse = false;
    mockPermissionLoaded = true;
    mockCanReadSiteNotification = true;
    mockPublicConfig = {
      maintenance: { enabled: false, message: null },
    };
    mockSiteNotification = null;
  });

  it("shows the maintenance screen instead of app content when maintenance mode is enabled", () => {
    mockPublicConfig = {
      maintenance: {
        enabled: true,
        message: "We are performing **maintenance** right now.",
      },
    };

    render(
      <AppShell>
        <div>Application content</div>
      </AppShell>,
    );

    expect(screen.getByText("Scheduled maintenance")).toBeInTheDocument();
    expect(screen.getByText("maintenance")).toBeInTheDocument();
    expect(screen.queryByText("Application content")).not.toBeInTheDocument();
    expect(screen.getByTestId("version")).toBeInTheDocument();
  });

  it("renders the active site notification banner in standard app routes", () => {
    mockSiteNotification = {
      markdown:
        "[Status page](https://status.example.com) is tracking this event.",
      expiresAt: null,
    };

    render(
      <AppShell>
        <div>Application content</div>
      </AppShell>,
    );

    const link = screen.getByRole("link", { name: "Status page" });
    expect(link).toHaveAttribute("href", "https://status.example.com");
    expect(screen.getByText("Application content")).toBeInTheDocument();
    expect(screen.getByTestId("app-sidebar")).toBeInTheDocument();
  });
});
