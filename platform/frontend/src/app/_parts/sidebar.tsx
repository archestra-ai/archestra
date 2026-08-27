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
  Brain,
  Bug,
  Cable,
  CircleDollarSign,
  Database,
  Files,
  FolderKanban,
  Github,
  Inbox,
  KeyRound,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  MoreHorizontal,
  Network,
  PencilRuler,
  Plug,
  Puzzle,
  Route,
  Settings,
  ShieldCheck,
  ShieldUser,
  Slack,
  Sparkles,
  Star,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import React from "react";
import { ChatSidebarSection } from "@/app/_parts/chat-sidebar-section";
import { getCostsNavigationUrl } from "@/app/_parts/costs-navigation";
import { SidebarUserMenu } from "@/app/_parts/sidebar-user-menu";
import { AppLogo } from "@/components/app-logo";
import { McpRegistryAttentionBadge } from "@/components/mcp-registry-attention-badge";
import { OnboardingDot } from "@/components/onboarding-dot";
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
import { useIsAuthenticated } from "@/lib/auth/auth.hook";
import { useHasPermissions, usePermissionMap } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useFeature } from "@/lib/config/config.query";
import { useGithubStars } from "@/lib/github/github.query";
import { useAppIconLogo } from "@/lib/hooks/use-app-name";
import { useOnce } from "@/lib/hooks/use-once";
import type { NavDotKey } from "@/lib/onboarding/nav-onboarding";
import { useNavOnboarding } from "@/lib/onboarding/use-nav-onboarding";
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
  /** Onboarding red-dot target; shown while the user hasn't visited the item. */
  dotKey?: NavDotKey;
  /** Chip label shown when `beta` is set; defaults to "New". */
  badgeLabel?: string;
  /**
   * Trailing live count, e.g. MCP servers needing attention. Rendered as a
   * sibling of the nav link rather than inside it: the badge is itself a link
   * to the filtered list, and an anchor may not contain another anchor.
   */
  countBadge?: React.ReactNode;
  /**
   * Pages whose permissions gate this item, for items whose `url` isn't in
   * `requiredPagePermissionsMap` (e.g. a landing page that redirects between
   * differently-gated tabs). Visible when ANY of them is permitted; without
   * this, gating falls back to `url`.
   */
  permissionUrls?: string[];
}

interface NavGroup {
  /** Stable React key, and the group's name in code regardless of its label. */
  id: string;
  /**
   * Section heading above the group's rows, in title case — the acronyms keep
   * their caps because that is how they are spelled, not a style applied to
   * them.
   *
   * Omitted for the closing group, which holds the app-wide rows that belong
   * to no section — it is separated by space alone.
   */
  label?: string;
  items: NavItem[];
}

function isNavItemPermitted(
  item: NavItem,
  permissionMap: Record<string, boolean>,
): boolean {
  if (item.permissionUrls) {
    // No `?? true` fallback here: these URLs are asserted to be in
    // requiredPagePermissionsMap, so a typo should hide the item, not
    // silently show it to everyone.
    return item.permissionUrls.some((url) => permissionMap[url] === true);
  }
  return permissionMap[item.url] ?? true;
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
    dotKey: "nav:projects",
  },
  {
    title: "Apps",
    url: "/apps",
    icon: AppWindow,
    customIsActive: (pathname: string) => pathname === "/apps",
    beta: true,
    dotKey: "nav:apps",
    badgeLabel: "Beta",
  },
  {
    title: "Connect",
    url: "/connection",
    icon: Cable,
    customIsActive: (pathname: string) => pathname.startsWith("/connection"),
    dotKey: "nav:connect",
  },
];

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
    "/skills",
    "/plugins",
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
  modeDots,
}: {
  mode: SidebarMode;
  onPick: (mode: SidebarMode) => void;
  /** Aggregate onboarding dots: some item in that tab is still unseen. */
  modeDots: Record<SidebarMode, boolean>;
}) {
  const segment = (value: SidebarMode, label: string, Icon: LucideIcon) => (
    <button
      type="button"
      key={value}
      onClick={() => onPick(value)}
      aria-pressed={mode === value}
      className={cn(
        "relative flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors",
        mode === value
          ? "bg-background font-medium text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" />
      {label}
      <OnboardingDot
        visible={modeDots[value]}
        className="absolute right-1 top-1"
      />
    </button>
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: role="group" is the correct ARIA pattern for a segmented toggle; <fieldset> is for form inputs
    <div
      role="group"
      aria-label="Sidebar view"
      className="flex rounded-lg border bg-muted p-0.5 group-data-[collapsible=icon]:hidden"
    >
      {segment("chats", "AI", MessageCircle)}
      {segment("studio", "Studio", PencilRuler)}
    </div>
  );
}

/**
 * Studio navigation, grouped by the object each row manages. Rows are broadly
 * one per page rather than one per section: a section's landing page used to
 * stand in for its siblings (Skills for Plugins, Model Providers for Models,
 * LLM Proxy for Virtual Keys and OAuth Clients), which left everything behind
 * the first tab invisible from the sidebar. Each page keeps its tab bar; the
 * sidebar now names what is there.
 *
 * Costs & Limits is the one row still covering two pages, kept that way to
 * hold the LLM group's height down.
 *
 * The headings take the Chats sidebar's own treatment for Pinned and Recents:
 * small, muted, title case. Set in caps they read as peers of the rows beneath
 * them, which is what made "AGENTS" above a row called Agents look like the
 * same word twice; at this weight they are a marker the eye skims past on the
 * way to the rows.
 */
const contentNavGroups: NavGroup[] = [
  {
    id: "agents",
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
        // Dropped entirely when the deployment has plugins turned off — see
        // the `pluginsEnabled` filter in `AppSidebar`.
        title: "Plugins",
        url: "/plugins",
        icon: Puzzle,
        customIsActive: (pathname: string) => pathname.startsWith("/plugins"),
        beta: true,
        badgeLabel: "Beta",
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
    id: "mcp",
    label: "MCP",
    items: [
      {
        title: "MCP Registry",
        url: "/mcp/registry",
        icon: Route,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/registry"),
        dotKey: "nav:mcp-registry",
        countBadge: <McpRegistryAttentionBadge />,
      },
      {
        title: "MCP Gateways",
        url: "/mcp/gateways",
        icon: Waypoints,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/gateways"),
      },
    ],
  },
  {
    id: "llm",
    label: "LLM",
    items: [
      {
        // Exact match: the proxy's sibling tabs are rows of their own now, so
        // a prefix match would light this row on all three.
        title: "LLM Proxy",
        url: "/llm/proxy",
        icon: Network,
        customIsActive: (pathname: string) => pathname === "/llm/proxy",
      },
      {
        title: "Virtual Keys",
        url: "/llm/proxy/virtual-keys",
        icon: KeyRound,
      },
      {
        title: "OAuth Clients",
        url: "/llm/proxy/oauth-clients",
        icon: ShieldUser,
      },
      {
        title: "Model Providers",
        url: "/llm/model-providers",
        icon: Boxes,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/model-providers"),
        // The dot covers the pair (see DOTTED_NAV_ITEMS): opening Models
        // clears it too.
        dotKey: "nav:model-providers",
      },
      {
        title: "Models",
        url: "/llm/models",
        icon: Brain,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/models"),
      },
      {
        // The one row in this list that still covers two pages. Costs and
        // Limits share a tab bar and the row would otherwise push the group
        // to eight; `getCostsNavigationUrl` picks which of the two it opens
        // for a reader who may not read both.
        title: "Costs & Limits",
        url: "/llm/costs",
        icon: CircleDollarSign,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/llm/costs") || pathname === "/llm/limits",
        permissionUrls: ["/llm/costs", "/llm/limits"],
      },
    ],
  },
  {
    id: "knowledge",
    // Its rows are the three Knowledge tabs. "Knowledge Bases" keeps the name
    // the rest of the product uses (page title, docs, API) rather than
    // shortening to "Bases" under the heading.
    label: "Knowledge",
    items: [
      {
        title: "Connectors",
        url: "/knowledge/connectors",
        icon: Plug,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge/connectors"),
      },
      {
        title: "Files",
        url: "/knowledge/files",
        icon: Files,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge/files"),
      },
      {
        title: "Knowledge Bases",
        url: "/knowledge/knowledge-bases",
        icon: Database,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge/knowledge-bases"),
      },
    ],
  },
  {
    // The rows that span every group above: what tools are allowed to do,
    // what they did, and how the deployment is configured.
    id: "platform",
    items: [
      {
        // Not under MCP: the page's own tools come from installed MCP
        // servers, from agents and apps, and from traffic between agents and
        // LLMs. The URL stays /mcp/tool-guardrails — docs and deep links
        // point at it, and the route is not what the reader is being told.
        title: "Guardrails",
        url: "/mcp/tool-guardrails",
        icon: ShieldCheck,
        testId: E2eTestId.SidebarNavGuardrails,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/mcp/tool-guardrails"),
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
      {
        title: "Settings",
        url: "/settings",
        icon: Settings,
        customIsActive: (pathname: string) => pathname.startsWith("/settings"),
        // /settings is a landing page that forwards to the first permitted
        // tab; show the item when the user can see any settings page.
        permissionUrls: [
          "/settings/appearance",
          "/settings/auth",
          "/settings/service-accounts",
          "/settings/agents",
          "/settings/security",
          "/settings/llm",
          "/settings/mcp",
          "/settings/skills",
          "/settings/knowledge",
          "/settings/environments",
          "/settings/users",
          "/settings/teams",
          "/settings/roles",
          "/settings/github",
          "/settings/identity-providers",
          "/settings/secrets",
        ],
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
          className="relative"
          onClick={() => {
            if (item.dotKey) onDotItemVisit(item.dotKey);
            if (isMobile) setOpenMobile(false);
          }}
        >
          <item.icon className={item.iconClassName} />
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
          {item.beta && (
            <Badge
              variant="secondary"
              className="ml-auto shrink-0 px-1.5 py-0 text-[10px] group-data-[collapsible=icon]:hidden"
            >
              {item.badgeLabel ?? "New"}
            </Badge>
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
  const pluginsEnabled = useFeature("plugins");

  const [sidebarMode, pickSidebarMode] = useSidebarMode(pathname);
  const chatListFadeIn = useOnce();
  // Onboarding red dots: unseen nav items for this user (RBAC/flag filtered).
  const { unseenKeys, showChatsDot, showStudioDot, markSeen } =
    useNavOnboarding();

  // Connect requires both MCP gateway and LLM proxy read permissions.
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
          .filter((item) => item.url !== "/plugins" || pluginsEnabled === true)
          // Costs & Limits is one row over two pages, so it has to choose
          // which one it opens: a reader who may read limits but not costs
          // would otherwise land on a page they cannot see.
          .map((item) =>
            item.url === "/llm/costs"
              ? { ...item, url: getCostsNavigationUrl(permissionMap) }
              : item,
          ),
      })),
    [pluginsEnabled, permissionMap],
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
                unseenDotKeys={unseenKeys}
                onDotItemVisit={markSeen}
              />
              {/* The chat list (Pinned + Recents, labeled inside
                    ChatSidebarSection) and the community links below it scroll
                    together within this region, while the nav above stays
                    pinned. The fade hints there is more content below. */}
              <SidebarGroup className="min-h-0 flex-1 overflow-hidden p-0 after:pointer-events-none after:absolute after:right-2.5 after:bottom-0 after:left-0 after:z-10 after:h-8 after:bg-gradient-to-t after:from-sidebar after:to-transparent">
                {/* group-data-[collapsible=icon]:overflow-hidden keeps this
                    scroller out of the tab order while collapsed — Chrome makes
                    scrollable containers keyboard-focusable, which otherwise
                    leaves an invisible tab stop on the icon rail (WCAG 2.4.3). */}
                <SidebarGroupContent className="min-h-0 flex-1 overflow-y-auto group-data-[collapsible=icon]:overflow-hidden pb-8 [scrollbar-gutter:stable] scrollbar-sidebar">
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
