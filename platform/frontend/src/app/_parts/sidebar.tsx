// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";
import {
  COMMUNITY_DOCS_URL,
  COMMUNITY_SLACK_URL,
  E2eTestId,
  GITHUB_REPO_NEW_ISSUE_URL,
  GITHUB_REPO_URL,
} from "@archestra/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Bug,
  Github,
  type LucideIcon,
  MessageCircle,
  PencilRuler,
  Plus,
  Search,
  Slack,
  Star,
} from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import React from "react";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
import { getCostsNavigationUrl } from "@/app/_parts/costs-navigation";
import { ShortcutHint } from "@/app/_parts/shortcut-hint";
import { SidebarUserMenu } from "@/app/_parts/sidebar-user-menu";
import {
  chatsNavItems,
  contentNavGroups,
  isNavItemPermitted,
  type NavGroup,
  type NavItem,
} from "@/app/_parts/studio-nav";
import { preloadAgentsPage } from "@/app/agents/preload";
import { prefetchMcpRegistry } from "@/app/mcp/registry/_parts/prefetch-registry";
import { AppLogo } from "@/components/app-logo";
import { IntentPrefetchLink } from "@/components/intent-prefetch-link";
import { OnboardingDot } from "@/components/onboarding-dot";
import { OpenAppaAlertIcon } from "@/components/openappa-icon";
import { SidebarWarningsAccordion } from "@/components/sidebar-warnings-accordion";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { SHORTCUT_NEW_CHAT } from "@/consts";
import { prefetchApps } from "@/lib/app.query";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useDocsScreenshotMode } from "@/lib/docs-screenshot-mode";
import { useGithubStars } from "@/lib/github/github.query";
import { useGuardrailsDeployment } from "@/lib/guardrails-deployment.query";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useOnce } from "@/lib/hooks/use-once";
import type { NavDotKey } from "@/lib/onboarding/nav-onboarding";
import { useNavOnboarding } from "@/lib/onboarding/use-nav-onboarding";
import { cn } from "@/lib/utils/tailwind";
import { getSettingsNavigationUrl } from "./settings-navigation";
import { useNavPermissionMap } from "./use-settings-area-access";

type SidebarMode = "chats" | "studio";

const SIDEBAR_MODE_STORAGE_KEY = "archestra-sidebar-mode";

/** Which tab a route belongs to; null = no opinion (keep the current tab). */
function routeSidebarMode(pathname: string): SidebarMode | null {
  const chatPrefixes = ["/chat", "/projects", "/apps", "/connection"];
  if (
    chatPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return "chats";
  }
  const studioPrefixes = [
    "/agents",
    "/a2a",
    "/skills",
    "/plugins",
    "/mcp",
    "/openappa",
    "/llm",
    "/knowledge",
    "/audit",
  ];
  if (
    studioPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return "studio";
  }
  return null;
}

/**
 * Chats/Studio tab state: explicit picks persist, and navigation that
 * clearly belongs to one tab (deep links included) switches to it.
 */
function useSidebarMode(pathname: string) {
  const [mode, setMode] = React.useState<SidebarMode>(
    () => routeSidebarMode(pathname) ?? "chats",
  );

  React.useEffect(() => {
    const stored = window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY);
    if (
      (stored === "chats" || stored === "studio") &&
      routeSidebarMode(window.location.pathname) === null
    ) {
      setMode(stored);
    }
  }, []);

  React.useEffect(() => {
    const routeMode = routeSidebarMode(pathname);
    if (routeMode) setMode(routeMode);
  }, [pathname]);

  const pick = React.useCallback((next: SidebarMode) => {
    setMode(next);
    window.localStorage.setItem(SIDEBAR_MODE_STORAGE_KEY, next);
  }, []);

  return [mode, pick] as const;
}

/** Segmented Chats/Studio control (hidden when the sidebar is collapsed). */
function SidebarModeToggle({
  mode,
  onPick,
  modeDots,
}: {
  mode: SidebarMode;
  onPick: (mode: SidebarMode) => void;
  /** Aggregate onboarding dots: some item in that tab is still unseen. */
  modeDots: Record<SidebarMode, boolean>;
}) {
  const segment = (value: SidebarMode, label: string, Icon: LucideIcon) => (
    <UnstyledButton
      type="button"
      key={value}
      onClick={() => onPick(value)}
      aria-pressed={mode === value}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
        mode === value
          ? // Light: a raised card on the muted track. Dark: a solid pill.
            "bg-raised font-medium text-foreground shadow-sm dark:bg-sidebar-emphasis dark:text-sidebar"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {label}
      <OnboardingDot
        visible={modeDots[value]}
        className="absolute right-1 top-1"
      />
    </UnstyledButton>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" is the correct ARIA pattern for a segmented toggle; <fieldset> is for form inputs
    <div
      role="group"
      aria-label="Sidebar view"
      className="flex gap-0.5 rounded-lg border border-sidebar-border bg-sidebar-track p-px group-data-[collapsible=icon]:hidden"
    >
      {segment("chats", "AI", MessageCircle)}
      {segment("studio", "Studio", PencilRuler)}
    </div>
  );
}

// Primary navigation: renders all items in a single SidebarGroup/SidebarMenu
const NavPrimary = ({
  items,
  groups,
  pathname,
  searchParams,
  permissionMap,
  unseenDotKeys,
  onDotItemVisit,
}: {
  items: NavItem[];
  groups: NavGroup[];
  pathname: string;
  searchParams: URLSearchParams;
  permissionMap: Record<string, boolean>;
  unseenDotKeys: Set<NavDotKey>;
  onDotItemVisit: (key: NavDotKey) => void;
}) => {
  const { isMobile, setOpenMobile } = useSidebar();

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.url}>
      <SidebarMenuButton
        asChild
        tooltip={item.tooltipLabel ?? item.title}
        className={item.className}
        isActive={
          item.customIsActive?.(pathname, searchParams) ??
          pathname.startsWith(item.url)
        }
      >
        <SidebarPrefetchLink
          href={item.url}
          data-testid={item.testId}
          className={cn(
            "relative",
            // The dot is pinned to the row's right edge, where a badge also
            // ends; pad the row so the badge clears the dot instead of
            // sitting underneath it.
            item.beta &&
              item.dotKey &&
              unseenDotKeys.has(item.dotKey) &&
              "pr-4",
          )}
          onClick={() => {
            if (item.dotKey) onDotItemVisit(item.dotKey);
            if (isMobile) setOpenMobile(false);
          }}
        >
          <item.icon className={item.iconClassName} />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {item.beta && (
            <NavItemBadge
              label={item.badgeLabel ?? "New"}
              tooltip={item.badgeTooltip}
            />
          )}
          {item.dotKey && (
            <OnboardingDot
              visible={unseenDotKeys.has(item.dotKey)}
              // Steps aside for a count badge, which is a `SidebarMenuAction`
              // pinned to the same corner. Keyed off the action actually being
              // in the DOM, not off the item declaring one: a badge that has
              // nothing to report renders nothing, and the dot keeps the
              // corner to itself.
              //
              // Centred on the row rather than pinned to its top: `top-1` put
              // a 6px dot 4px down a 32px row, which read as floating above
              // the label instead of belonging to it. Centring is `inset-y-0`
              // plus `my-auto` rather than `top-1/2 -translate-y-1/2` because
              // the dot's enter/exit animation keyframes set `transform`
              // themselves and would drop the centring translate mid-play.
              className="absolute inset-y-0 my-auto h-1.5 right-1 group-has-data-[sidebar=menu-action]/menu-item:right-8"
            />
          )}
        </SidebarPrefetchLink>
      </SidebarMenuButton>
      {item.countBadge}
      {item.subItems && item.subItems.length > 0 && (
        <SidebarMenuSub className="mx-0 ml-3.5 px-0 pl-2.5">
          {item.subItems
            .filter((sub) => permissionMap[sub.url] ?? true)
            .map((sub) => (
              <SidebarMenuSubItem key={sub.title}>
                <SidebarMenuSubButton
                  asChild
                  isActive={
                    sub.customIsActive?.(pathname, searchParams) ??
                    pathname.startsWith(sub.url)
                  }
                >
                  <SidebarPrefetchLink
                    href={sub.url}
                    data-testid={sub.testId}
                    onClick={() => {
                      if (isMobile) setOpenMobile(false);
                    }}
                  >
                    <span>{sub.title}</span>
                  </SidebarPrefetchLink>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            ))}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );

  const permittedHeaderItems = items.filter((item) =>
    isNavItemPermitted(item, permissionMap),
  );
  // In Studio mode the header items don't include New Chat, and when collapsed
  // the Chats/Studio toggle is hidden — so surface a collapsed-only New Chat in
  // the icon rail. Skipped when New Chat is already a header item (Chats mode),
  // to avoid a duplicate.
  const hasNewChat = permittedHeaderItems.some((item) => item.url === "/chat");

  return (
    <SidebarGroup>
      <SidebarMenu>
        {!hasNewChat && (
          <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
            <SidebarMenuButton
              asChild
              tooltip="New Chat"
              isActive={pathname === "/chat"}
            >
              <SidebarPrefetchLink
                href="/chat"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <MessageCircle />
                <span>New Chat</span>
              </SidebarPrefetchLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        {permittedHeaderItems.map((item) =>
          item.url === "/chat" ? (
            // New chat leads the Chats list, above the places it links to.
            // Search sits on the chat list's first group label instead.
            <SidebarNewChatItem key={item.url} />
          ) : (
            renderItem(item)
          ),
        )}
        {/* The rail's search. Expanded, search lives on the chat list's first
            group label, which the rail folds away. */}
        <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
          <SidebarMenuButton
            tooltip="Search"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("open-conversation-search"));
            }}
          >
            <Search />
            <span>Search</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {groups
        .map((group) => ({
          group,
          permittedItems: group.items.filter((item) =>
            isNavItemPermitted(item, permissionMap),
          ),
        }))
        .filter(({ permittedItems }) => permittedItems.length > 0)
        .map(({ group, permittedItems }, index) => (
          <React.Fragment key={group.id}>
            {group.label && (
              <SidebarGroupLabel role="heading" aria-level={2}>
                {group.label}
              </SidebarGroupLabel>
            )}
            {/* Each group is its own list under its own heading. The heading's
                own row height is the space between groups; a group without one
                — and the group that renders first, whichever survives the
                permission filter — supplies that space itself. Collapsed to
                the icon rail the headings fold away, so the spacing goes with
                them and the icons keep a single rhythm. */}
            <SidebarMenu
              className={cn(
                !group.label &&
                  index > 0 &&
                  "mt-4 group-data-[collapsible=icon]:mt-0",
              )}
            >
              {permittedItems.map(renderItem)}
            </SidebarMenu>
          </React.Fragment>
        ))}
    </SidebarGroup>
  );
};

// Matches sidebar-10 NavSecondary: SidebarGroup with mt-auto
// Community links are optional chrome; gate them so white-labeled shells do not
// render the links or trigger their noncritical GitHub metadata queries.
const NavSecondary = ({
  items,
  pathname,
  searchParams,
  permissionMap,
  showCommunityLinks,
  starCount,
  className,
}: {
  items: NavItem[];
  pathname: string;
  searchParams: URLSearchParams;
  permissionMap: Record<string, boolean>;
  showCommunityLinks: boolean;
  starCount: string;
  className?: string;
}) => {
  const permittedItems = items.filter((item) =>
    isNavItemPermitted(item, permissionMap),
  );
  // An empty group still takes its padding and gaps, leaving a blank band
  // between the chat list and the footer.
  if (permittedItems.length === 0 && !showCommunityLinks) {
    return null;
  }

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          {permittedItems.map((item) => (
            <SidebarMenuItem key={item.url}>
              <SidebarMenuButton
                asChild
                tooltip={item.title}
                isActive={
                  item.customIsActive?.(pathname, searchParams) ??
                  pathname.startsWith(item.url)
                }
              >
                <SidebarPrefetchLink href={item.url}>
                  <item.icon className={item.iconClassName} />
                  <span>{item.title}</span>
                </SidebarPrefetchLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          {showCommunityLinks && (
            <>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Star us on GitHub">
                  <a
                    href={GITHUB_REPO_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Github />
                    <span className="flex items-center gap-2">
                      Star us on GitHub
                      <span className="flex items-center gap-1 text-xs">
                        <Star className="h-3 w-3" />
                        {starCount}
                      </span>
                    </span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Documentation">
                  <a
                    href={COMMUNITY_DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <BookOpen />
                    <span>Documentation</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Talk to developers">
                  <a
                    href={COMMUNITY_SLACK_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Slack />
                    <span>Talk to developers</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Report a bug">
                  <a
                    href={GITHUB_REPO_NEW_ISSUE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Bug />
                    <span>Report a bug</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
};

export function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isAuthenticated = useIsAuthenticated();
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  // Show community menu items unless the Enterprise license env var is set
  // (the small-team free tier doesn't hide them).
  const showLicenseCommunityLinks = !config.enterpriseFeatures.core;
  // SPDX-SnippetEnd
  const docsScreenshotMode = useDocsScreenshotMode();
  const showCommunityLinks = showLicenseCommunityLinks && !docsScreenshotMode;
  // GitHub stars are cosmetic and external, so defer them until after the
  // authenticated shell data has had a chance to load.
  const { data: starCount } = useGithubStars({
    enabled: showCommunityLinks && isAuthenticated,
    deferMs: 5000,
  });
  const formattedStarCount = starCount ?? "";
  const permissionMap = useNavPermissionMap();
  const appIconLogo = useAppIconLogo();
  // Connect is useful with either half: MCP-only (tools) or proxy-only
  // (inference). Org settings can hide a section without hiding the page.
  const { data: canReadLlmProxy } = useHasPermissions({
    llmProxy: ["read"],
  });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const showConnect = Boolean(canReadMcpGateway || canReadLlmProxy);
  const { data: guardrailsDeployment } = useGuardrailsDeployment();
  const modelPoolsEnabled = useFeature("llmModelPoolsEnabled") === true;

  const [sidebarMode, pickSidebarMode] = useSidebarMode(pathname);
  const chatListFadeIn = useOnce();
  // Onboarding red dots: unseen nav items for this user (RBAC/flag filtered).
  const onboarding = useNavOnboarding();
  const { markSeen } = onboarding;
  // Screenshots show the steady-state shell, not a first visit's dots.
  const unseenKeys = docsScreenshotMode
    ? NO_UNSEEN_KEYS
    : onboarding.unseenKeys;
  const showChatsDot = !docsScreenshotMode && onboarding.showChatsDot;
  const showStudioDot = !docsScreenshotMode && onboarding.showStudioDot;

  // Connect is offered when either MCP gateway or LLM proxy is readable.
  const filteredChatsNavItems = React.useMemo(
    () =>
      chatsNavItems.filter((item) => {
        if (item.title === "Connect") return showConnect;
        return true;
      }),
    [showConnect],
  );

  // Advertising a page this deployment turned off sends the reader looking for
  // something that isn't there, so Plugins waits for the flag answer rather
  // than appearing and then vanishing.
  const filteredNavGroups = React.useMemo(
    () =>
      contentNavGroups.map((group) => ({
        ...group,
        items: group.items
          // Model pools are a beta feature, off unless this deployment's flag
          // is on, so the row waits for the answer rather than flashing.
          .filter(
            (item) => item.url !== "/llm/model-pools" || modelPoolsEnabled,
          )
          // Costs & Limits is one row over two pages, so it has to choose
          // which one it opens: a reader who may read limits but not costs
          // would otherwise land on a page they cannot see.
          .map((item) => {
            // Enforcement off is the state an operator needs to notice, so the
            // row itself carries the warning instead of a second status row.
            if (
              item.url === "/openappa" &&
              guardrailsDeployment?.enabled === false
            ) {
              return {
                ...item,
                icon: OpenAppaAlertIcon,
                iconClassName: "size-4 shrink-0",
                className:
                  "text-destructive hover:text-destructive data-[active=true]:text-destructive",
              };
            }
            if (
              item.url === "/openappa" &&
              permissionMap &&
              !permissionMap["/openappa"]
            ) {
              return { ...item, url: "/openappa/yells" };
            }
            if (item.url === "/llm/costs") {
              return { ...item, url: getCostsNavigationUrl(permissionMap) };
            }
            // Same reason one row over: /settings is a stub that forwards to
            // the first permitted tab, so following it costs a second route
            // load for every click.
            if (item.url === "/settings") {
              return { ...item, url: getSettingsNavigationUrl(permissionMap) };
            }
            return item;
          }),
      })),
    [guardrailsDeployment?.enabled, modelPoolsEnabled, permissionMap],
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="pt-4 group-data-[collapsible=icon]:pt-2 group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1">
        <div className="group-data-[collapsible=icon]:hidden">
          <SidebarPrefetchLink href="/chat" className="block min-w-0">
            <AppLogo />
          </SidebarPrefetchLink>
        </div>
        <SidebarPrefetchLink
          href="/chat"
          className="hidden group-data-[collapsible=icon]:flex"
        >
          <img src={appIconLogo} alt="Logo" className="size-7" />
        </SidebarPrefetchLink>
        {isAuthenticated && permissionMap && (
          <SidebarModeToggle
            mode={sidebarMode}
            onPick={pickSidebarMode}
            modeDots={{ chats: showChatsDot, studio: showStudioDot }}
          />
        )}
      </SidebarHeader>
      {/* The nav scrolls under the footer; the fade keeps the last row from
          ending in a hard cut. It takes its own space at the end, so it covers
          nothing once scrolled to the bottom or when nothing overflows. The
          top fade overlaps the first rows (negative margin) so rows scrolling
          under the header soften the same way. */}
      <SidebarContent
        className={cn(
          "relative",
          // The chat list scrolls and fades on its own; this fade would only
          // add a blank band between it and the footer.
          sidebarMode !== "chats" &&
            "before:pointer-events-none before:sticky before:top-0 before:z-10 before:-mb-4 before:block before:h-4 before:shrink-0 before:bg-gradient-to-b before:from-sidebar before:to-transparent before:content-[''] after:pointer-events-none after:sticky after:bottom-0 after:-mt-2 after:block after:h-4 after:shrink-0 after:bg-gradient-to-t after:from-sidebar after:to-transparent after:content-['']",
        )}
      >
        {isAuthenticated &&
          permissionMap &&
          (sidebarMode === "chats" ? (
            <>
              <NavPrimary
                items={filteredChatsNavItems}
                groups={[]}
                pathname={pathname}
                searchParams={searchParams}
                permissionMap={permissionMap}
                unseenDotKeys={unseenKeys}
                onDotItemVisit={markSeen}
              />
              {/* Keep sessions scrollable while the navigation and community
                  links stay in place. The fades soften rows scrolling under
                  the nav above and hint at more sessions below. */}
              <SidebarGroup className="min-h-0 flex-1 overflow-hidden p-0 before:pointer-events-none before:absolute before:top-0 before:right-2.5 before:left-0 before:z-10 before:h-4 before:bg-gradient-to-b before:from-sidebar before:to-transparent after:pointer-events-none after:absolute after:right-2.5 after:bottom-0 after:left-0 after:z-10 after:h-4 after:bg-gradient-to-t after:from-sidebar after:to-transparent">
                {/* group-data-[collapsible=icon]:overflow-hidden keeps this
                    scroller out of the tab order while collapsed — Chrome makes
                    scrollable containers keyboard-focusable, which otherwise
                    leaves an invisible tab stop on the icon rail (WCAG 2.4.3). */}
                <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto group-data-[collapsible=icon]:overflow-hidden pb-4 [scrollbar-gutter:stable] scrollbar-sidebar">
                  <ChatSidebarSection slots={15} flat fadeIn={chatListFadeIn} />
                </SidebarGroupContent>
              </SidebarGroup>
              <NavSecondary
                items={[]}
                pathname={pathname}
                searchParams={searchParams}
                permissionMap={permissionMap}
                showCommunityLinks={showCommunityLinks}
                starCount={formattedStarCount}
                className="mt-auto"
              />
            </>
          ) : (
            <>
              <NavPrimary
                items={[]}
                groups={filteredNavGroups}
                pathname={pathname}
                searchParams={searchParams}
                permissionMap={permissionMap}
                unseenDotKeys={unseenKeys}
                onDotItemVisit={markSeen}
              />
              <NavSecondary
                items={[]}
                pathname={pathname}
                searchParams={searchParams}
                permissionMap={permissionMap}
                showCommunityLinks={showCommunityLinks}
                starCount={formattedStarCount}
                className="mt-auto"
              />
            </>
          ))}
        {!isAuthenticated && showCommunityLinks && (
          <NavSecondary
            items={[]}
            pathname={pathname}
            searchParams={searchParams}
            permissionMap={{}}
            showCommunityLinks={showCommunityLinks}
            starCount={formattedStarCount}
          />
        )}
      </SidebarContent>
      <SidebarFooter>
        {/* The studio nav already shows the Guardrails row, tinted red while
            enforcement is off, so the status row would only repeat it. */}
        {!docsScreenshotMode && (
          <SidebarWarningsAccordion
            showGuardrailsStatus={sidebarMode !== "studio"}
          />
        )}
        {isAuthenticated && (
          <SidebarGroup className="mt-auto p-0">
            <SidebarGroupContent>
              <div
                data-testid={E2eTestId.SidebarUserProfile}
                className={cn(
                  "overflow-hidden",
                  // Collapsed: hide text/chevron, show only avatar circle
                  "group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center",
                  "group-data-[collapsible=icon]:[&_button]:size-7 group-data-[collapsible=icon]:[&_button]:min-w-0 group-data-[collapsible=icon]:[&_button]:rounded-full group-data-[collapsible=icon]:[&_button]:p-0",
                  "group-data-[collapsible=icon]:[&_[data-slot=avatar]]:size-7",
                  "group-data-[collapsible=icon]:[&_[data-slot=avatar-fallback]]:text-[9px]",
                  "group-data-[collapsible=icon]:[&_button>div]:gap-0",
                  "group-data-[collapsible=icon]:[&_button>div>div:not([data-slot=avatar])]:hidden",
                  "group-data-[collapsible=icon]:[&_button>svg]:hidden",
                )}
              >
                <SidebarUserMenu />
              </div>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * Sidebar links opt out of Next.js viewport prefetch to avoid fetching every
 * visible sidebar route's RSC payload when the app shell mounts. Hover/focus
 * prefetch keeps intentional navigation fast without competing with initial
 * page API requests.
 */
function SidebarPrefetchLink(
  props: Omit<React.ComponentProps<typeof IntentPrefetchLink>, "onPrefetch">,
) {
  const queryClient = useQueryClient();

  return (
    <IntentPrefetchLink
      {...props}
      // The registry is a dynamic page without a loading boundary: only a
      // full prefetch fetches its own payload and JavaScript before the click.
      fullPrefetch={isRegistryHref(props.href)}
      onPrefetch={(href) => {
        // Route prefetch doesn't mount client query hooks. Start the matching
        // first page alongside it, not after the destination's JavaScript loads.
        if (href === "/apps") void prefetchApps(queryClient);
        // The route prefetch stops at the Agents page's loading boundary;
        // load its code as well. Its data streams from the server on the
        // click, so nothing is fetched for it here.
        if (href === "/agents") preloadAgentsPage();
        // The registry's payload carries no data on a client navigation (the
        // server renders its first page only into full page loads), so its
        // first page is fetched here, once.
        if (isRegistryHref(href)) void prefetchMcpRegistry(queryClient, href);
      }}
    />
  );
}

function isRegistryHref(href: unknown): href is string {
  return (
    typeof href === "string" &&
    (href === "/mcp/registry" || href.startsWith("/mcp/registry?"))
  );
}

const NO_UNSEEN_KEYS: Set<NavDotKey> = new Set();

function NavItemBadge({ label, tooltip }: { label: string; tooltip?: string }) {
  const badge = (
    <Badge
      variant="outline"
      className="ml-auto shrink-0 border-transparent bg-sidebar-chip px-1.5 py-0 text-[10px] text-sidebar-emphasis dark:border-sidebar-emphasis dark:bg-sidebar group-data-[collapsible=icon]:hidden"
    >
      {label}
    </Badge>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent side="right">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The Chats sidebar's first action: an outlined button, set apart from the
 * plain rows below it, with the shortcut that does the same (Alt+N, handled
 * by `useConversationSearch`). In the collapsed rail it is a plain icon like
 * its neighbours. An action rather than a place, so it never shows as the
 * current page.
 */
function SidebarNewChatItem() {
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        tooltip="New chat"
        className="h-9 rounded-lg border bg-sidebar-raised font-medium shadow-xs group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:shadow-none"
      >
        <SidebarPrefetchLink
          href="/chat"
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <Plus />
          <span className="min-w-0 flex-1 truncate">New chat</span>
          <ShortcutHint modifier="alt" letter={SHORTCUT_NEW_CHAT.label} />
        </SidebarPrefetchLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
