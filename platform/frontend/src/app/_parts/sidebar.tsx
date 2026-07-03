// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
"use client";
import {
  COMMUNITY_DOCS_URL,
  COMMUNITY_SLACK_URL,
  E2eTestId,
  GITHUB_REPO_NEW_ISSUE_URL,
  GITHUB_REPO_URL,
} from "@archestra/shared";
import { requiredPagePermissionsMap } from "@archestra/shared/access-control";
import {
  AppWindow,
  BookOpen,
  Bot,
  Boxes,
  Bug,
  Cable,
  CircleDollarSign,
  Database,
  FolderKanban,
  Github,
  Inbox,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  Network,
  PencilRuler,
  Route,
  ShieldCheck,
  Slack,
  Sparkles,
  Star,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React from "react";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
import { SidebarUserMenu } from "@/app/_parts/sidebar-user-menu";
import { AppLogo } from "@/components/app-logo";
import { SidebarWarningsAccordion } from "@/components/sidebar-warnings-accordion";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";

import { useGithubStars } from "@/lib/github/github.query";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useOnce } from "@/lib/hooks/use-once";
import { cn } from "@/lib/utils";

interface NavSubItem {
  title: string;
  url: string;
  testId?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
}

interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  iconClassName?: string;
  testId?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
  onClick?: () => void;
  subItems?: NavSubItem[];
  beta?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

type SidebarMode = "chats" | "studio";

const SIDEBAR_MODE_STORAGE_KEY = "archestra-sidebar-mode";

// Items of the Chats tab (flat list above Recents)
const chatsNavItems: NavItem[] = [
  {
    title: "New Chat",
    url: "/chat",
    icon: MessageCircle,
    customIsActive: (pathname: string) => pathname === "/chat",
  },
  {
    title: "Projects",
    url: "/projects",
    icon: FolderKanban,
    customIsActive: (pathname: string) => pathname.startsWith("/projects"),
    beta: true,
  },
  {
    title: "Apps",
    url: "/apps",
    icon: AppWindow,
    customIsActive: (pathname: string) => pathname === "/apps",
    beta: true,
  },
  {
    title: "Connect",
    url: "/connection",
    icon: Cable,
    customIsActive: (pathname: string) => pathname.startsWith("/connection"),
    beta: true,
  },
];

/** Which tab a route belongs to; null = no opinion (keep the current tab). */
function routeSidebarMode(pathname: string): SidebarMode | null {
  const chatPrefixes = [
    "/chat",
    "/projects",
    "/apps",
    "/connection",
    "/connection_beta",
  ];
  if (
    chatPrefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return "chats";
  }
  const studioPrefixes = [
    "/agents",
    "/scheduled-tasks",
    "/mcp",
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
}: {
  mode: SidebarMode;
  onPick: (mode: SidebarMode) => void;
}) {
  const segment = (value: SidebarMode, label: string, Icon: LucideIcon) => (
    <button
      type="button"
      key={value}
      onClick={() => onPick(value)}
      className={cn(
        "flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
        mode === value
          ? "bg-background font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );

  return (
    <div className="flex rounded-lg border bg-muted p-0.5 group-data-[collapsible=icon]:hidden">
      {segment("chats", "AI", MessageCircle)}
      {segment("studio", "Studio", PencilRuler)}
    </div>
  );
}

// Labeled groups shown in the scrollable content (like sidebar-10 Favorites/Workspaces)
const contentNavGroups: NavGroup[] = [
  {
    label: "Agents",
    items: [
      {
        title: "Agents",
        url: "/agents",
        icon: Bot,
        customIsActive: (pathname: string) => pathname.startsWith("/agents"),
      },
      {
        title: "Skills",
        url: "/skills",
        icon: Sparkles,
        customIsActive: (pathname: string) => pathname.startsWith("/skills"),
        beta: true,
      },
      {
        title: "Messaging Channels",
        url: "/messaging-channels",
        icon: Inbox,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/messaging-channels"),
      },
    ],
  },
  {
    label: "MCP & Tools",
    items: [
      {
        title: "Guardrails",
        url: "/mcp/tool-guardrails",
        icon: ShieldCheck,
        testId: E2eTestId.SidebarNavGuardrails,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/tool-guardrails"),
      },
      {
        title: "MCP Registry",
        url: "/mcp/registry",
        icon: Route,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/registry"),
      },
      {
        title: "MCP Gateways",
        url: "/mcp/gateways",
        icon: Waypoints,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/gateways"),
        subItems: [
          {
            title: "Credentials",
            url: "/mcp/credentials/oauth-clients",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/mcp/credentials"),
          },
        ],
      },
    ],
  },
  {
    label: "LLM Proxies",
    items: [
      {
        title: "LLM Proxies",
        url: "/llm/proxies",
        icon: Network,
        customIsActive: (pathname: string) => pathname === "/llm/proxies",
        subItems: [
          {
            title: "Credentials",
            url: "/llm/credentials/virtual-keys",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/llm/credentials"),
          },
        ],
      },
      {
        title: "Model Providers",
        url: "/llm/model-providers",
        icon: Boxes,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/model-providers") ||
          pathname.startsWith("/llm/models"),
      },
      {
        title: "Costs & Limits",
        url: "/llm/costs",
        icon: CircleDollarSign,
      },
    ],
  },
  {
    label: "Other",
    items: [
      {
        title: "Knowledge",
        url: "/knowledge/knowledge-bases",
        icon: Database,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge") &&
          !pathname.startsWith("/knowledge/connectors"),
        subItems: [
          {
            title: "Connectors",
            url: "/knowledge/connectors",
            customIsActive: (pathname: string) =>
              pathname.startsWith("/knowledge/connectors"),
          },
        ],
      },
      {
        title: "Logs",
        url: "/llm/logs",
        icon: MessagesSquare,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/logs") ||
          pathname.startsWith("/mcp/logs") ||
          pathname.startsWith("/audit/logs"),
      },
    ],
  },
];

// Primary navigation: renders all items in a single SidebarGroup/SidebarMenu
const NavPrimary = ({
  items,
  groups,
  pathname,
  searchParams,
  permissionMap,
}: {
  items: NavItem[];
  groups: NavGroup[];
  pathname: string;
  searchParams: URLSearchParams;
  permissionMap: Record<string, boolean>;
}) => {
  const { isMobile, setOpenMobile } = useSidebar();

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.title}>
      <SidebarMenuButton
        asChild
        tooltip={item.title}
        isActive={
          item.customIsActive?.(pathname, searchParams) ??
          pathname.startsWith(item.url)
        }
      >
        <SidebarPrefetchLink
          href={item.url}
          data-testid={item.testId}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <item.icon className={item.iconClassName} />
          <span>{item.title}</span>
          {item.beta && (
            <Badge
              variant="secondary"
              className="ml-auto px-1.5 py-0 text-[10px] group-data-[collapsible=icon]:hidden"
            >
              New
            </Badge>
          )}
        </SidebarPrefetchLink>
      </SidebarMenuButton>
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

  const permittedHeaderItems = items.filter(
    (item) => permissionMap[item.url] ?? true,
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
        {permittedHeaderItems.map(renderItem)}
        <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
          <SidebarMenuButton
            tooltip="Search chats"
            onClick={() => {
              window.dispatchEvent(
                new CustomEvent("open-conversation-search", {
                  detail: { recentChatsView: true },
                }),
              );
            }}
          >
            <MoreHorizontal />
            <span>Search chats</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {groups.map((group) => {
          const permittedItems = group.items.filter(
            (item) => permissionMap[item.url] ?? true,
          );
          if (permittedItems.length === 0) return null;
          return (
            <React.Fragment key={group.label}>
              {permittedItems.map(renderItem)}
            </React.Fragment>
          );
        })}
      </SidebarMenu>
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
  const permittedItems = items.filter(
    (item) => permissionMap[item.url] ?? true,
  );

  return (
    <SidebarGroup className={className}>
      <SidebarGroupContent>
        <SidebarMenu>
          {permittedItems.map((item) => (
            <SidebarMenuItem key={item.title}>
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
  const showCommunityLinks = !config.enterpriseFeatures.core;
  // SPDX-SnippetEnd
  // GitHub stars are cosmetic and external, so defer them until after the
  // authenticated shell data has had a chance to load.
  const { data: starCount } = useGithubStars({
    enabled: showCommunityLinks && isAuthenticated,
    deferMs: 5000,
  });
  const formattedStarCount = starCount ?? "";
  const permissionMap = usePermissionMap(requiredPagePermissionsMap);
  const appIconLogo = useAppIconLogo();
  // Connect page requires both MCP gateway and LLM proxy read permissions
  const { data: canReadLlmProxy } = useHasPermissions({
    llmProxy: ["read"],
  });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const showConnect = canReadMcpGateway && canReadLlmProxy;

  const [sidebarMode, pickSidebarMode] = useSidebarMode(pathname);
  const chatListFadeIn = useOnce();
  // ARCHESTRA_BETA master switch — when on, the new connection page is the
  // default Connect destination.
  const betaEnabled = useFeature("betaEnabled") === true;

  // Connect requires both MCP gateway and LLM proxy read permissions, and
  // points at its beta route when ARCHESTRA_BETA is on.
  const filteredChatsNavItems = React.useMemo(
    () =>
      chatsNavItems
        .filter((item) => {
          if (item.title === "Connect") return showConnect;
          return true;
        })
        .map((item) => {
          if (item.title === "Connect" && betaEnabled) {
            return { ...item, url: "/connection_beta" };
          }
          return item;
        }),
    [showConnect, betaEnabled],
  );

  // With ARCHESTRA_BETA on, some nav items point at their beta routes.
  const filteredNavGroups = React.useMemo(() => {
    const betaNavUrls: Record<string, string> = {
      "MCP Registry": "/mcp/registry/beta",
    };
    return contentNavGroups.map((group) => ({
      ...group,
      items: group.items.map((item) => {
        const betaUrl = betaEnabled ? betaNavUrls[item.title] : undefined;
        return betaUrl ? { ...item, url: betaUrl } : item;
      }),
    }));
  }, [betaEnabled]);

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
          <SidebarModeToggle mode={sidebarMode} onPick={pickSidebarMode} />
        )}
      </SidebarHeader>
      <SidebarContent>
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
              />
              {/* The chat list (Pinned + Recents, labeled inside
                    ChatSidebarSection) and the community links below it scroll
                    together within this region, while the nav above stays
                    pinned. The fade hints there is more content below. */}
              <SidebarGroup className="min-h-0 flex-1 overflow-hidden p-0 after:pointer-events-none after:absolute after:right-2.5 after:bottom-0 after:left-0 after:z-10 after:h-8 after:bg-gradient-to-t after:from-sidebar after:to-transparent">
                <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto pb-8 [scrollbar-gutter:stable] scrollbar-sidebar">
                  <ChatSidebarSection slots={15} flat fadeIn={chatListFadeIn} />
                  <NavSecondary
                    items={[]}
                    pathname={pathname}
                    searchParams={searchParams}
                    permissionMap={permissionMap}
                    showCommunityLinks={showCommunityLinks}
                    starCount={formattedStarCount}
                    className="mt-2.5"
                  />
                </SidebarGroupContent>
              </SidebarGroup>
            </>
          ) : (
            <>
              <NavPrimary
                items={[]}
                groups={filteredNavGroups}
                pathname={pathname}
                searchParams={searchParams}
                permissionMap={permissionMap}
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
        <SidebarWarningsAccordion />
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
function SidebarPrefetchLink({
  href,
  onFocus,
  onMouseEnter,
  ...props
}: React.ComponentProps<typeof Link>) {
  const router = useRouter();

  return (
    <Link
      href={href}
      prefetch={false}
      onFocus={(event) => {
        const prefetchHref = getPrefetchHref(href);
        if (prefetchHref) router.prefetch(prefetchHref);
        onFocus?.(event);
      }}
      onMouseEnter={(event) => {
        const prefetchHref = getPrefetchHref(href);
        if (prefetchHref) router.prefetch(prefetchHref);
        onMouseEnter?.(event);
      }}
      {...props}
    />
  );
}

/**
 * Converts a Next.js Link href into the string URL required by router.prefetch.
 * Sidebar links currently pass strings, but this keeps manual prefetch safe if
 * a future item uses a UrlObject with query or hash fields.
 */
function getPrefetchHref(href: React.ComponentProps<typeof Link>["href"]) {
  if (typeof href === "string") return href;
  if (!href.pathname) return null;

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(href.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) searchParams.append(key, String(item));
      }
      continue;
    }
    if (value != null) searchParams.set(key, String(value));
  }

  const query = searchParams.toString();
  return `${href.pathname}${query ? `?${query}` : ""}${href.hash ?? ""}`;
}
