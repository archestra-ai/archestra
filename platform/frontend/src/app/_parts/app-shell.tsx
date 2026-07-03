"use client";

import type { Permissions } from "@archestra/shared/permission.types";
import { usePathname } from "next/navigation";
import { ConnectivityStatusBar } from "@/components/connectivity-status-bar";
import { ConversationSearchProvider } from "@/components/conversation-search-provider";
import { FeedbackPopupDialog } from "@/components/feedback-popup-dialog";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import {
  NavigationStatusProvider,
  useNavigationStatus,
} from "@/components/navigation-status-provider";
import { OnboardingSurveyDialog } from "@/components/onboarding-survey-dialog";
import {
  SidebarCircleToggle,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Version } from "@/components/version";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  ConnectivityProvider,
  useConnectivity,
} from "@/lib/config/connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useNavOnboarding } from "@/lib/onboarding/use-nav-onboarding";
import { useActiveSiteNotification } from "@/lib/site-notification.query";
import { cn } from "@/lib/utils";
import { MaintenanceModeOverlay } from "./maintenance-mode-overlay";
import { AppSidebar } from "./sidebar";
import {
  EnvSiteNotificationBar,
  SiteNotificationBar,
} from "./site-notification-bar";

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
  // Full-page app runtimes all live under /a/… (the owned standalone
  // /a/[appId] and the external /a/catalog/[catalogId]), so the whole
  // namespace is chrome-less by construction — no per-route regexes to keep in
  // sync. (The /apps gallery itself keeps the shell.)
  const isAppRuntime = pathname.startsWith("/a/");
  // Chat and project detail pages are viewport-locked, two-pane layouts
  // (content + right Files sidebar) that scroll each pane independently. They
  // need their children slot bounded to the viewport (min-h-0) so their
  // internal overflow containers take over. Other pages rely on natural body
  // scroll, so we only bound the chain for these to avoid clipping content.
  const isChat = pathname === "/chat" || pathname.startsWith("/chat/");
  const isProjectDetail = /^\/projects\/[^/]+/.test(pathname);
  const isViewportLocked = isChat || isProjectDetail;
  const { data: shouldCollapse, isSuccess: permissionLoaded } =
    useHasPermissions(SIDEBAR_COLLAPSED_PERMISSION);
  const { data: canReadSiteNotification } = useHasPermissions(
    SITE_NOTIFICATION_READ_PERMISSION,
  );
  const { data: notification } = useActiveSiteNotification({
    enabled:
      canReadSiteNotification === true &&
      !isAuthPage &&
      !isBrowserPreview &&
      !isAppRuntime,
  });

  // Chromeless surfaces (browser preview, app runtime): no sidebar/header/version.
  if (isBrowserPreview || isAppRuntime) {
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
        <EnvSiteNotificationBar />
        <div className="flex-1 flex flex-col">{children}</div>
        <Version />
        <Toaster />
      </main>
    );
  }

  // Authenticated shell. ConnectivityProvider wraps both the permission-loading
  // skeleton and the full shell so /health polling and useConnectivity() are
  // available on every page rendered here — including before the sidebar mounts
  // (a page like /chat calls useConnectivity() unconditionally). The
  // auth/preview/runtime branches above are intentionally outside it (no poll).
  return (
    <ConnectivityProvider>
      {!permissionLoaded ? (
        // Wait for the permission check before rendering the sidebar to avoid a
        // flash. Don't render Version here — the full-width layout centers
        // differently than the sidebar layout, so the footer would visibly jump.
        <main className="h-screen w-full flex flex-col bg-background min-w-0 relative">
          <MaintenanceModeOverlay />
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-1 flex flex-col">{children}</div>
          </div>
          <Toaster />
        </main>
      ) : (
        <NavigationStatusProvider>
          <SidebarProvider defaultOpen={!shouldCollapse}>
            <AppSidebar />
            <NavAwareSidebarCircleToggle />
            <MaintenanceModeOverlay />
            <main className="h-screen w-full flex flex-col bg-background min-w-0 relative overflow-y-auto">
              <ConnectivityBar />
              <EnvSiteNotificationBar />
              {notification && (
                <SiteNotificationBar
                  content={notification.content}
                  notificationId={notification.id}
                />
              )}
              <ImpersonationBanner />
              <header className="h-14 border-b border-border flex md:hidden items-center justify-between px-6 bg-card/50 backdrop-blur supports-backdrop-filter:bg-card/50">
                <NavAwareSidebarTrigger />
                <div
                  id="mobile-header-actions"
                  className="flex items-center gap-2"
                />
              </header>
              <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                <div
                  className={cn(
                    "flex-1 flex flex-col",
                    isViewportLocked && "min-h-0",
                  )}
                >
                  {children}
                </div>
                <Version />
              </div>
            </main>
            <Toaster />
            <ConversationSearchProvider />
            <OnboardingSurveyDialog />
            <FeedbackPopupDialog />
          </SidebarProvider>
        </NavigationStatusProvider>
      )}
    </ConnectivityProvider>
  );
}

function ConnectivityBar() {
  const { state, retry } = useConnectivity();
  const appName = useAppName();
  return (
    <ConnectivityStatusBar state={state} onRetry={retry} appName={appName} />
  );
}

function NavAwareSidebarCircleToggle() {
  const { isNavigating } = useNavigationStatus();
  const { showCollapsedToggleDot } = useNavOnboarding();
  return (
    <SidebarCircleToggle
      loading={isNavigating}
      showDot={showCollapsedToggleDot}
    />
  );
}

function NavAwareSidebarTrigger() {
  const { showCollapsedToggleDot } = useNavOnboarding();
  return (
    <SidebarTrigger
      className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2 -ml-2"
      showDot={showCollapsedToggleDot}
    />
  );
}
