"use client";

// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { E2eTestId } from "@archestra/shared";
import {
  AppWindow,
  Bot,
  Boxes,
  Brain,
  Cable,
  CircleDollarSign,
  Database,
  Files,
  FolderKanban,
  KeyRound,
  type LucideIcon,
  MessageCircle,
  MessagesSquare,
  Network,
  Plug,
  Puzzle,
  Route,
  Settings,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from "lucide-react";
import type React from "react";
import { McpRegistryAttentionBadge } from "@/components/mcp-registry-attention-badge";
import type { NavDotKey } from "@/lib/onboarding/nav-onboarding";

/**
 * What the product's navigation is, separately from any one thing that draws
 * it. The sidebar renders these as rows; the search palette turns the same
 * list into destinations you can jump to by name. It used to keep a list of
 * its own, which had drifted — "Tool Guardrails" where the sidebar said
 * "Guardrails", an entry pointing at the Microsoft Teams tab rather than
 * Messaging Channels, six pages missing outright, and no permission gating at
 * all, so it offered pages the reader could not open.
 */

export interface NavSubItem {
  title: string;
  url: string;
  testId?: string;
  customIsActive?: (pathname: string, searchParams: URLSearchParams) => boolean;
}

export interface NavItem {
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
   * Tooltip text for the collapsed icon rail, where the group headings are
   * folded away and a row has only its own name to identify it. Set it where
   * that name is ambiguous without the heading above it — two rows both called
   * "OAuth Clients", a "Files" that could be any of several kinds. Defaults to
   * `title`.
   */
  tooltipLabel?: string;
  /**
   * Pages whose permissions gate this item, for items whose `url` isn't in
   * `requiredPagePermissionsMap` (e.g. a landing page that redirects between
   * differently-gated tabs). Visible when ANY of them is permitted; without
   * this, gating falls back to `url`.
   */
  permissionUrls?: string[];
}

export interface NavGroup {
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

export function isNavItemPermitted(
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

// Items of the Chats tab (flat list above Recents)
export const chatsNavItems: NavItem[] = [
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

export const contentNavGroups: NavGroup[] = [
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
        tooltipLabel: "Knowledge Connectors",
        url: "/knowledge/connectors",
        icon: Plug,
        customIsActive: (pathname: string) =>
          pathname.startsWith("/knowledge/connectors"),
      },
      {
        title: "Files",
        tooltipLabel: "Knowledge Files",
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
