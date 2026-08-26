"use client";

import { APP_RECORDING_RENDER_ROUTE } from "@archestra/shared";
import type { Permissions } from "@archestra/shared/permission.types";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MOBILE_HEADER_ACTIONS_CONTAINER_ID } from "@/components/chat/chat-help-link";
import { ConnectivityStatusBar } from "@/components/connectivity-status-bar";
import { ConversationSearchProvider } from "@/components/conversation-search-provider";
import { FeedbackPopupDialog } from "@/components/feedback-popup-dialog";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { LoadingState } from "@/components/loading";
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
import { MAIN_CONTENT_ID } from "@/lib/app-shell-region";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import {
  ConnectivityProvider,
  useConnectivity,
} from "@/lib/config/connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useIsAppLoading } from "@/lib/hooks/use-is-app-loading";
import { useNavOnboarding } from "@/lib/onboarding/use-nav-onboarding";
import { useOrganization } from "@/lib/organization.query";
import { useActiveSiteNotification } from "@/lib/site-notification.query";
import { cn } from "@/lib/utils";
import { MaintenanceModeOverlay } from "./maintenance-mode-overlay";
import { McpDeploymentStatusFeed } from "./mcp-deployment-status-feed";
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

/**
 * When the organization requires 2FA and the signed-in user hasn't enrolled,
 * every non-exempt API call is refused anyway — send them straight to the
 * enrollment page instead of flashing the app chrome and waiting for the
 * first 403 to bounce them.
 */
function useTwoFactorEnrollmentRedirect(enabled: boolean): boolean {
  const { data: session } = useSession();
  const { data: organization } = useOrganization();
  const mustEnroll =
    !!organization?.requireTwoFactor &&
    !!session &&
    !session.user.twoFactorEnabled;
  const shouldRedirect = enabled && mustEnroll;
  useEffect(() => {
    if (shouldRedirect) {
      window.location.replace("/auth/two-factor-setup");
    }
  }, [shouldRedirect]);
  return shouldRedirect;
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
  // The hackathon submission review host is its own full-page surface (banner +
  // metadata + the read-only replay player); it brings its own chrome, so the
  // app sidebar/header stay out of its way.
  const isReview = pathname === "/review" || pathname.startsWith("/review/");
  // Driven by the offline video renderer: its frames must contain the replay
  // and nothing of the surrounding app.
  const isRecordingRender = pathname.startsWith(APP_RECORDING_RENDER_ROUTE);
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
  const [sidebarOpen, setSidebarOpen] = useSidebarOpenState({
    shouldCollapse: shouldCollapse === true,
    permissionLoaded,
  });
  const { data: canReadSiteNotification } = useHasPermissions(
    SITE_NOTIFICATION_READ_PERMISSION,
  );
  const { data: notification } = useActiveSiteNotification({
    enabled:
      canReadSiteNotification === true &&
      !isAuthPage &&
      !isBrowserPreview &&
      !isAppRuntime &&
      !isReview,
  });

  const redirectingToTwoFactorSetup = useTwoFactorEnrollmentRedirect(
    !isAuthPage &&
      !isBrowserPreview &&
      !isAppRuntime &&
      !isRecordingRender &&
      !isReview,
  );
  if (redirectingToTwoFactorSetup) {
    return (
      <main className="h-app-viewport w-full flex items-center justify-center bg-background">
        <LoadingState variant="viewport" />
      </main>
    );
  }

  // Chromeless surfaces (browser preview, app runtime, video render, review):
  // no sidebar/header/version.
  if (isBrowserPreview || isAppRuntime || isRecordingRender || isReview) {
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
      <main className="h-app-viewport w-full flex flex-col bg-background">
        <MaintenanceModeOverlay />
        <EnvSiteNotificationBar />
        <div className="flex-1 flex flex-col">{children}</div>
        <Version />
        <Toaster />
      </main>
    );
  }

  // Authenticated shell. It renders as soon as we know the visitor is signed
  // in — the permission check that decides the sidebar's default width no
  // longer gates it. Waiting for that check used to mean a full-screen
  // "Loading your workspace…" ahead of the shell, and then a second loader
  // inside the shell once it appeared: two indicators, at two different
  // centres, in the space of a few hundred milliseconds. Boot progress is
  // reported in the sidebar toggle instead (see NavAwareSidebarCircleToggle).
  //
  // ConnectivityProvider wraps the shell so /health polling and
  // useConnectivity() are available on every page rendered here (a page like
  // /chat calls useConnectivity() unconditionally). The auth/preview/runtime
  // branches above are intentionally outside it (no poll).
  return (
    <ConnectivityProvider>
      <McpDeploymentStatusFeed />
      <NavigationStatusProvider>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SkipToContentLink />
          {/* The toggle is position:fixed, so DOM order only affects focus
                order: keeping it before the sidebar means expanding it with
                the keyboard tabs forward into the revealed sidebar content
                instead of skipping to <main> (WCAG 2.4.3). */}
          <NavAwareSidebarCircleToggle />
          <AppSidebar />
          <MaintenanceModeOverlay />
          {/* MAIN_CONTENT_ID + tabIndex={-1} make this the "skip to main
              content" target (WCAG 2.4.1 Bypass Blocks), so activating that
              link moves keyboard focus past the sidebar navigation and into
              the page. A fullscreen MCP App sizes itself to the same element
              (see McpAppCard), which is why the id is shared rather than
              spelled twice. */}
          <main
            id={MAIN_CONTENT_ID}
            tabIndex={-1}
            className="h-app-viewport w-full flex flex-col bg-background min-w-0 relative overflow-y-auto focus:outline-none"
          >
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
                id={MOBILE_HEADER_ACTIONS_CONTAINER_ID}
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

/**
 * The app's only loading indicator. It sits in a fixed position on the sidebar
 * edge, so it reports progress without moving anything on the page — which is
 * the whole point: page-level loaders were appearing at three different
 * heights during a single refresh.
 */
function NavAwareSidebarCircleToggle() {
  const { isNavigating } = useNavigationStatus();
  const { showCollapsedToggleDot } = useNavOnboarding();
  const isAppLoading = useIsAppLoading();
  const loading = isNavigating || isAppLoading;
  return (
    <>
      {/* The toggle's spinner is decorative, so the same state is announced
          here (WCAG 4.1.3). This is the only announcement left now that the
          page-level loaders are gone, and it is polite and unlabelled while
          idle, so it does not interrupt or repeat. */}
      <output aria-live="polite" className="sr-only">
        {loading ? <span>Loading…</span> : null}
      </output>
      <SidebarCircleToggle loading={loading} showDot={showCollapsedToggleDot} />
    </>
  );
}

/**
 * Sidebar width, resolved without a jump.
 *
 * The width a user ends up with depends on a permission that arrives over the
 * network, so rendering the shell before it lands means guessing. Guess with
 * the width this browser last used (the sidebar already writes it to a cookie
 * on every toggle) and the guess is right for everyone but a first-ever
 * visitor. Once the permission resolves it wins, unless the user has since
 * moved the sidebar themselves.
 */
function useSidebarOpenState({
  shouldCollapse,
  permissionLoaded,
}: {
  shouldCollapse: boolean;
  permissionLoaded: boolean;
}): [boolean, (open: boolean) => void] {
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const lastKnown = useRef<boolean | null>(null);
  lastKnown.current ??= readSidebarStateCookie();

  const open =
    userChoice ??
    (permissionLoaded ? !shouldCollapse : (lastKnown.current ?? true));

  return [open, setUserChoice];
}

function readSidebarStateCookie(): boolean | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)sidebar_state=(true|false)/);
  return match ? match[1] === "true" : null;
}

// Visually hidden until focused; the first tab stop on every authenticated
// page, letting keyboard and screen-reader users jump past the sidebar nav.
function SkipToContentLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md focus:ring-2 focus:ring-ring"
    >
      Skip to main content
    </a>
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
