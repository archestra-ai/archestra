"use client";

import { usePathname } from "next/navigation";
import {
  type CSSProperties,
  startTransition,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MOBILE_HEADER_ACTIONS_CONTAINER_ID,
  MOBILE_HEADER_TITLE_CONTAINER_ID,
} from "@/components/chat/chat-help-link";
import { ConnectivityStatusBar } from "@/components/connectivity-status-bar";
import { ConversationSearchProvider } from "@/components/conversation-search-provider";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { LoadingState } from "@/components/loading";
import {
  NavigationStatusProvider,
  useNavigationStatus,
} from "@/components/navigation-status-provider";
import {
  SidebarCircleToggle,
  SidebarPlaceholder,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { Version } from "@/components/version";
import { afterNextPaint, appInteractive } from "@/lib/app-interactive";
import { MAIN_CONTENT_ID } from "@/lib/app-shell-region";
import { useSession } from "@/lib/auth/auth.query";
import { seededConversationId } from "@/lib/auth/shell-seed";
import {
  ConnectivityProvider,
  useConnectivity,
} from "@/lib/config/connectivity";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useIsAppLoading } from "@/lib/hooks/use-is-app-loading";
import { useNavOnboarding } from "@/lib/onboarding/use-nav-onboarding";
import { useOrganization } from "@/lib/organization.query";
import { useIsShellSeeded, useShellReady } from "@/lib/shell-deferral";
import { useActiveSiteNotification } from "@/lib/site-notification.query";
import { lazyComponent } from "@/lib/utils/preloadable-lazy";
import { cn } from "@/lib/utils/tailwind";
import { AuthSurfaceFrame } from "./auth-surface-frame";
import { MaintenanceModeOverlay } from "./maintenance-mode-overlay";
import { McpDeploymentStatusFeed } from "./mcp-deployment-status-feed";
import { AppSidebar } from "./sidebar";
import {
  SidebarResizeHandle,
  useSidebarWidthState,
} from "./sidebar-resize-handle";
import {
  EnvSiteNotificationBar,
  SiteNotificationBar,
} from "./site-notification-bar";

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
  const isAuthCallback =
    pathname === "/oauth-callback" ||
    pathname === "/github/callback" ||
    pathname === "/github/app-setup";
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
  const [sidebarOpen, setSidebarOpen] = useSidebarOpenState();
  const sidebarWidth = useSidebarWidthState();
  // Every signed-in user sees the active banner.
  // The banner waits for the page's first data (see useShellReady).
  const shellReady = useShellReady();
  // A server-seeded page has the banner and the sidebar's data in its HTML,
  // so both render with the page instead of after it.
  const shellSeeded = useIsShellSeeded();
  const { data: notification } = useActiveSiteNotification({
    enabled: shellReady && !isAuthPage && !isBrowserPreview && !isAppRuntime,
  });

  const redirectingToTwoFactorSetup = useTwoFactorEnrollmentRedirect(
    !isAuthPage && !isBrowserPreview && !isAppRuntime,
  );
  if (redirectingToTwoFactorSetup) {
    return (
      <main className="h-app-viewport w-full flex items-center justify-center bg-background">
        <LoadingState variant="viewport" />
      </main>
    );
  }

  // Chromeless surfaces (browser preview, app runtime):
  // no sidebar/header/version.
  if (isBrowserPreview || isAppRuntime || isAuthCallback) {
    return (
      <>
        <MaintenanceModeOverlay />
        {children}
        <Toaster />
      </>
    );
  }

  // Auth pages: render without sidebar, centered content with version at
  // bottom. The frame is shared with WithAuthCheck's session gate so the
  // loading indicator it shows ahead of this branch is centred in the same box.
  if (isAuthPage) {
    return (
      <>
        <MaintenanceModeOverlay />
        <AuthSurfaceFrame>{children}</AuthSurfaceFrame>
        <Toaster />
      </>
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
  // ConnectivityProvider wraps the shell so /ready polling and
  // useConnectivity() are available on every page rendered here (a page like
  // /chat calls useConnectivity() unconditionally). The auth/preview/runtime
  // branches above are intentionally outside it (no poll).
  return (
    <ConnectivityProvider>
      <McpDeploymentStatusFeed />
      <NavigationStatusProvider>
        <SidebarProvider
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          style={
            {
              "--sidebar-width": `${sidebarWidth.width}px`,
            } as CSSProperties
          }
          // The width follows the pointer while dragging; easing it would lag,
          // and an eased collapse button would trail behind the sidebar edge.
          className={cn(
            sidebarWidth.resizing &&
              "cursor-col-resize select-none **:data-[slot=sidebar-container]:transition-none **:data-[slot=sidebar-gap]:transition-none **:data-[slot=sidebar-circle-toggle]:transition-none",
          )}
        >
          <SkipToContentLink />
          {/* The toggle is position:fixed, so DOM order only affects focus
                order: keeping it before the sidebar means expanding it with
                the keyboard tabs forward into the revealed sidebar content
                instead of skipping to <main> (WCAG 2.4.3). */}
          <NavAwareSidebarCircleToggle />
          <DeferredSidebar defer={isChat && !shellSeeded} />
          <SidebarResizeHandle
            width={sidebarWidth.width}
            onWidthChange={sidebarWidth.setWidth}
            onResizingChange={sidebarWidth.setResizing}
          />
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
            className="h-app-viewport w-full flex flex-col bg-background min-w-0 relative overflow-y-auto md:overflow-clip focus:outline-none"
          >
            <div className="shrink-0">
              <ConnectivityBar />
              <EnvSiteNotificationBar />
              {notification && (
                <SiteNotificationBar
                  content={notification.content}
                  notificationId={notification.id}
                />
              )}
              <ImpersonationBanner />
              <header className="h-14 border-b border-border flex md:hidden items-center justify-between gap-4 px-4 bg-card/50 backdrop-blur supports-backdrop-filter:bg-card/50">
                <NavAwareSidebarTrigger />
                <div
                  id={MOBILE_HEADER_TITLE_CONTAINER_ID}
                  className="flex min-w-0 flex-1 items-center"
                />
                {/* Collapsed while empty, so the header gap does not push a
                    page's title row off the right edge. */}
                <div
                  id={MOBILE_HEADER_ACTIONS_CONTAINER_ID}
                  className="flex items-center gap-2 empty:hidden"
                />
              </header>
            </div>
            <div
              data-page-scroll-container
              className="flex-1 min-h-0 min-w-0 flex flex-col overflow-visible md:overflow-y-auto"
            >
              <div
                className={cn(
                  "flex-1 flex flex-col",
                  isViewportLocked && "min-h-0",
                )}
              >
                {children}
              </div>
              {/* The new-chat screen shows its own version line under the
                  composer (`ChatPageContent` in `app/chat/page.client.tsx`)
                  and hides this one with the `hide-version` body class, but
                  only after it mounts: rendering it there would draw two
                  lines on the server and drop one as the page starts,
                  moving the centred composer. */}
              {pathname !== "/chat" && !seededConversationId(pathname) && (
                <Version />
              )}
            </div>
          </main>
          <Toaster />
          <ConversationSearchProvider />
          <AfterIdle>
            <OnboardingSurveyDialog />
          </AfterIdle>
        </SidebarProvider>
      </NavigationStatusProvider>
    </ConnectivityProvider>
  );
}

/**
 * On chat pages the server did not seed, the sidebar after the page's first
 * commit. Its navigation, conversation list and their queries are not what
 * the visitor came for, so the first render draws its empty frame at the
 * exact width, and the real sidebar replaces it in a transition right after
 * the page (the chat composer) has committed and painted. A seeded page has
 * the sidebar's data and renders it in the HTML. Its code ships with the
 * shell: loaded later, it would not be there when the page hydrates, and the
 * server's sidebar would drop to the frame and back.
 */
function DeferredSidebar({ defer }: { defer: boolean }) {
  // Only where the composer is the first screen. Elsewhere the sidebar mounts
  // with the page, as before: deferring it there buys nothing and moves its
  // mount into the moment someone starts using the page.
  const [mounted, setMounted] = useState(!defer);
  useEffect(() => {
    afterNextPaint(() => startTransition(() => setMounted(true)));
  }, []);
  if (!mounted) return <SidebarPlaceholder collapsible="icon" />;
  return <AppSidebar />;
}

/** Renders its children from the first idle callback after the app is interactive. */
function AfterIdle({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void appInteractive.whenIdle().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return ready ? <>{children}</> : null;
}

const OnboardingSurveyDialog = lazyComponent(() =>
  import("@/components/onboarding-survey-dialog").then(
    (m) => m.OnboardingSurveyDialog,
  ),
);

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
 * Whether the sidebar is open: the person's own last choice, remembered in
 * this browser, and open until they make one.
 */
function useSidebarOpenState(): [boolean, (open: boolean) => void] {
  const [choice, setChoice] = useState<boolean | null>(null);
  const remembered = useSyncExternalStore(
    subscribeToStorage,
    readRememberedSidebarOpen,
    () => null,
  );

  const open = choice ?? remembered ?? true;
  const setOpen = useCallback((next: boolean) => {
    setChoice(next);
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable (private mode); the choice still holds
      // for this page.
    }
  }, []);

  return [open, setOpen];
}

const SIDEBAR_OPEN_STORAGE_KEY = "archestra-sidebar-open";

function readRememberedSidebarOpen(): boolean | null {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY);
    return stored === "true" ? true : stored === "false" ? false : null;
  } catch {
    return null;
  }
}

function subscribeToStorage(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
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
      className="cursor-pointer hover:bg-accent transition-colors rounded-md p-2"
      showDot={showCollapsedToggleDot}
    />
  );
}
