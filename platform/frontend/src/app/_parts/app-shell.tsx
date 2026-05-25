"use client";

import type { Permissions } from "@shared/permission.types";
import { usePathname } from "next/navigation";
import { ConversationSearchProvider } from "@/components/conversation-search-provider";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import {
  NavigationStatusProvider,
  useNavigationStatus,
} from "@/components/navigation-status-provider";
import { OnboardingDialogWrapper } from "@/components/onboarding-dialog-wrapper";
import {
  SidebarCircleToggle,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Version } from "@/components/version";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useActiveSiteNotification } from "@/lib/site-notification.query";
import { MaintenanceModeOverlay } from "./maintenance-mode-overlay";
import { AppSidebar } from "./sidebar";
import { SiteNotificationBar } from "./site-notification-bar";

const SIDEBAR_COLLAPSED_PERMISSION: Permissions = {
  simpleView: ["enable"],
};

const SITE_NOTIFICATION_READ_PERMISSION: Permissions = {
  siteNotification: ["read"],
};

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();
  const isBrowserPreview = pathname.startsWith("/chat/browser-preview/");
  const isAuthPage = pathname.startsWith("/auth/");
  const { data: shouldCollapse, isSuccess: permissionLoaded } =
    useHasPermissions(SIDEBAR_COLLAPSED_PERMISSION);
  const { data: canReadSiteNotification } = useHasPermissions(
    SITE_NOTIFICATION_READ_PERMISSION,
  );
  const { data: notification } = useActiveSiteNotification({
    enabled:
      canReadSiteNotification === true && !isAuthPage && !isBrowserPreview,
  });

  // Browser preview mode: render children directly without sidebar/header/version
  if (isBrowserPreview) {
    return (
      <>
        <MaintenanceModeOverlay />
        {children}
        <Toaster />
      </>
    );
  }

  // Auth pages: render without sidebar, centered content with version at bottom
  if (isAuthPage) {
    return (
      <main className="h-screen w-full flex flex-col bg-background">
        <MaintenanceModeOverlay />
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        <Version />
        <Toaster />
      </main>
    );
  }

  // Wait for permission check before rendering sidebar to avoid flash.
  // Don't render Version here — the full-width layout has a different center
  // than the sidebar layout, causing the footer to visibly jump on load.
  if (!permissionLoaded) {
    return (
      <main className="h-screen w-full flex flex-col bg-background min-w-0 relative">
        <MaintenanceModeOverlay />
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 flex flex-col">{children}</div>
        </div>
        <Toaster />
      </main>
    );
  }

  // Normal mode: render full app shell with sidebar
  return (
    <NavigationStatusProvider>
      <SidebarProvider defaultOpen={!shouldCollapse}>
        <AppSidebar />
        <NavAwareSidebarCircleToggle />
        <MaintenanceModeOverlay />
        <main className="h-screen w-full flex flex-col bg-background min-w-0 relative">
          {notification && (
            <SiteNotificationBar content={notification.content} />
          )}
          <ImpersonationBanner />
          <header className="h-14 border-b border-border flex md:hidden items-center justify-between px-6 bg-card/50 backdrop-blur supports-backdrop-filter:bg-card/50">
            <SidebarTrigger className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2" />
            <div
              id="mobile-header-actions"
              className="flex items-center gap-2"
            />
          </header>
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">{children}</div>
            <Version />
          </div>
        </main>
        <Toaster />
        <OnboardingDialogWrapper />
        <ConversationSearchProvider />
      </SidebarProvider>
    </NavigationStatusProvider>
  );
}

function NavAwareSidebarCircleToggle() {
  const { isNavigating } = useNavigationStatus();
  return <SidebarCircleToggle loading={isNavigating} />;
}
